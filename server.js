import bodyParser from "body-parser";
import crypto from "crypto";
import 'dotenv/config';
import express from "express";
import { Feed } from "feed";
import frontmatter from 'frontmatter';
import fs from "fs/promises";
import { Liquid } from 'liquidjs';
import markdownIt from "markdown-it";
import markdownItAttr from "markdown-it-attrs";
import markdownItBracketedSpans from "markdown-it-bracketed-spans";
import { mf2 } from 'microformats-parser';
import fetch from "node-fetch";
import yaml from "yaml";
import { CronJob } from "cron";

// Post Handling
let marker = new markdownIt({
    html: true,
    breaks: true
})
    .use(markdownItBracketedSpans)
    .use(markdownItAttr);

let posts = new Map();
let idQueue = [];

async function consumePost(postPath, optinalPostID){
    const front
            = frontmatter(await fs.readFile(`./${postPath}`)
                .then((result) => result.toString()));

    front.data.rawContent = front.content
    front.data.content = marker.render(front.content.trim() ?? "") ?? "";
    if(optinalPostID){
        front.data.id = optinalPostID;
        savePostData(postPath, front.data)
    }

    if(front.data.id){
        posts.set(front.data.id, front.data);
        // if(!front.data.published && postDate([front.data.id, front.data]) && process.env.BRIDGY) {
        //     await sendWebmention(`https://${process.env.DOMAIN}/post/${front.data.id}`,"https://fed.brid.gy/")
        //     front.data.published = true;
        //     savePostData(postPath, front.data)
        // }
    } else {
        idQueue.push(postPath);
    }
    return;
}

async function generateId(){
    let validID = false;
    let result = "";
    let existingIDs = new Array(posts.keys());
    while (!validID){
        result = crypto.randomBytes(3).toString("hex");
        if(!existingIDs.includes(result)){
            validID = true;
        }
    }
    return result
}

async function savePostData(postPath, postData){
    let fileContent =
        "---\n" +
        yaml.stringify({
            ...postData,
            content: undefined,
            rawContent: undefined
        }) +
        "---\n" +
        postData.rawContent.trim()
    fs.writeFile(postPath, fileContent)
    
}

async function loadPosts() {

    let files = await fs.readdir("./posts",{withFileTypes:true})
        .then(files=>files.filter(file=>!file.isDirectory())).then(files=>files.map(file=>"posts/"+file.name));

    let promises = []

    files.forEach(file => {
        promises.push(consumePost(file))
    });

    await Promise.all(promises)
}

// Basic App Setup
let app = express()
let engine = new Liquid()

app.engine("liquid", engine.express())

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ "extended": true }));

app.set("trust proxy", "loopback")
app.set("view engine", "liquid");
app.use("/static", express.static("static"));

function sortDate (alpha, beta) {return Date.parse(beta[1].date) - Date.parse(alpha[1].date) }
// Do not show posts yet to appear
function postDate (post) {return Date.parse(post[1].date) < Date.now()}

app.get("/post/*",(req,res)=>res.render("home.liquid",{posts: [[req.params[0],posts.get(req.params[0])]]}))
app.get("/", (req,res)=>res.render("home.liquid",{
    posts: Array.from(posts.entries())
        .filter(postDate)
        .sort(sortDate)
        .filter(post=>(req.query?.tag && post[1].hashtags?.includes(req.query?.tag)) ?? (req.query?.tag == null))
    }))
app.get("/oldest", (req,res)=>res.render("home.liquid",{
    posts: Array.from(posts.entries())
        .filter(postDate)
        .sort(sortDate)
        .reverse()
        .filter(post=>(req.query?.tag && post[1].hashtags?.includes(req.query?.tag)) ?? (req.query?.tag == null))
    }))

// Rss

app.get("/posts.rss",(req,res)=>{
    res.set('Content-Type', 'application/rss+xml');
    const feed = new Feed({
        title: "",
        description: "",
        id: `https://${process.env.DOMAIN}/`,
        link: `https://${process.env.DOMAIN}/`,
        copyright: "",
        feedLinks: {
            rss: `https://${process.env.DOMAIN}/posts.rss`
        },
        author: {
            name: "",
            link: `https://${process.env.DOMAIN}/`
        }
    })
    Array.from(posts.entries())
        .filter(postDate)
        .sort(sortDate)
        .filter(post=>(req.query?.tag && post[1].hashtags?.includes(req.query?.tag)) ?? (req.query?.tag == null))
        .forEach(post => {
            feed.addItem({
                title: "",
                description: "",
                id: `https://${process.env.DOMAIN}/post/${post[1].id}`,
                link: `https://${process.env.DOMAIN}/post/${post[1].id}`,
                content: post[1].content
            })
        })
    res.send(feed.rss2())
})

// Webmentions

const urlOrNull = (url, base = undefined) => {
    try {
        return new URL(url, base);
    } catch (err) {
        return null;
    }
};

app.post("/webmentions", async (req, res)=>{
    return res.sendStatus(501)
    try {

        let source = urlOrNull(req.body.source, `${req.headers["x-forwarded-proto"] ?? req.protocol}://${req.get("host")}`);
        let target = urlOrNull(req.body.target, `${req.headers["x-forwarded-proto"] ?? req.protocol}://${req.get("host")}`);
        let slug = target.pathname.substring(6)

        if(req.headers["content-type"] != "application/json") return res.sendStatus(415)

        if (
            !source
            || !target
            || target.host != req.headers.host
            || target.pathname.substring(0, 6) != "/post/"
            || (
                (req.headers["x-forwarded-proto"] ?? req.protocol) !== "http"
                && (req.headers["x-forwarded-proto"] ?? req.protocol) !== "https"
            )
            || !posts.has(slug)) {
            return res.status(404).send("Post not found");
        }

        let sourceRes = await fetch(source.href)

        if(sourceRes.ok){
            let microformats = mf2(await sourceRes.text(), {
                baseUrl: source.origin
            })
            if(microformats.items.length == 0){
                return res.sendStatus(400)
            }
            if(microformats.items.filter(item=>item.type.includes("h-entry"))[0].properties["in-reply-to"]){
                let replyTo = urlOrNull(microformats.items.filter(item=>item.type.includes("h-entry"))[0].properties["in-reply-to"]) ?? urlOrNull(microformats.items.filter(item=>item.type.includes("h-entry"))[0].properties["in-reply-to"][0])
                if(posts.has(replyTo.pathname.substring(6))){
                    //This is where we save webmentions
                    return res.sendStatus(200)
                } else {
                    return res.sendStatus(404)
                }
            }
        } else {
            res.sendStatus(500)
            return
        }

    } catch (error) {
        console.error(error);
        res.sendStatus(500);
        return
    }

})

async function sendWebmention(sourceUrl, targetUrl){

    let target = urlOrNull(targetUrl)

    let sourceRes = await fetch(target)

        if(sourceRes.ok){
            let microformats = mf2(await sourceRes.text(), {
                baseUrl: target.origin
            })
            if(microformats.rels.webmention){
                fetch(
                    microformats.rels.webmention[0],
                    {
                        method: "POST",
                        "body": `source=${sourceUrl}&target=${targetUrl}`,
                        headers: {
                            "Content-Type": "application/x-www-form-urlencoded"
                        }
                    }
                )
            }
        }
}

// Activity Pub Stuff. Ugh i didn't want to do this.



// Update Posts

let testcron = new CronJob(
    "30 * * * * *",
    () => {
        loadPosts()
        idQueue.forEach(async postPath=>{
            console.log("Generating Id")
            await consumePost(postPath, await generateId())
        })
    },
    null,
    true
)


// Final Startup Stuff

await loadPosts()
idQueue.forEach(async postPath=>{
    console.log("Generating Id")
    await consumePost(postPath, await generateId())
})

app.listen(process.env.PORT, ()=>{console.log("Listening on port", process.env.PORT)})
