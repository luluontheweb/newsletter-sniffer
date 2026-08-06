import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import * as cheerio from "cheerio";
import axios from "axios";
const newslettersURL = "https://toby.fangamer.com";
const progressURL = "https://deltarune.com/7b/";

// essentials
const state = existsSync("state.json") ? JSON.parse(readFileSync("state.json", "utf8")) : { newsletters: [], progress: "" };
const saveState = () => writeFileSync("state.json", JSON.stringify(state, null, 2));
const log = async (data, error) => {
    const timestamp = new Date().toISOString();
    if (error) {
        const errorStr = `[${timestamp}] ${data}: ${error.message}, ${error.stack || 'no stack trace available'}\n`;
        console.error(`[${timestamp}] ${data}:`, error);
        appendFileSync(`errors.log`, errorStr);
    } else {
        console.log(`[${timestamp}] ${data}`);
        appendFileSync(`logs.log`, `[${timestamp}] ${data}\n`);
    };
};
const sleep = (s) => new Promise(resolve => setTimeout(resolve, s * 1000));

// discord
const discordQueue = [];
let discordHandler = null;
const postDiscord = (name, color, title, description, url) => {
    discordQueue.push({ content: "@everyone", embeds: [{ author: { name }, color, title, description, url }] });
    if (!discordHandler) discordHandler = (async () => {
        const post = async (content) => {
            try {
                await axios.post(process.env.webhook, content);
            } catch (e) {
                if (e.status !== 429) throw e;
                await sleep(e.data?.["retry_after"] ?? 10);
                return post(content);
            };
        };
        while (discordQueue.length > 0) {
            log(`Discord queue size: ${discordQueue.length}`);
            const content = discordQueue.shift();
            await post(content);
        };
        log(`Discord queue empty!`);
        discordHandler = null;
    })();
};

// crawlers
const checkNewsletters = async () => {
    log("Checking for new newsletters...");
    try {
        const newslettersPage = await axios.get(`${newslettersURL}/newsletters`);
        const $ = cheerio.load(newslettersPage.data);
        $("#articles").children().get().reverse().forEach((article) => {
            const href = article.attribs['href'];
            if (!state.newsletters.includes(href)) {
                state.newsletters.push(href);
                saveState();
                const url = `${newslettersURL}${href}`;
                const [title, description] = $(article).text().split('\n').map(s => s.trim()).filter(s => s);
                log(`NEW NEWSLETTER! ${url}\n    ${title}\n    ${description}`);
                postDiscord("New newsletter!", 0xffff00, title, description, url);
            };
        });
    } catch (e) {
        log("error", e);
    };
};

const checkProgress = async () => {
    log("Checking for progress...");
    try {
        const progressPage = await axios.get(progressURL);
        const $ = cheerio.load(progressPage.data);
        const innerText = $('body').prop('innerText');
        if (innerText !== state.progress) {
            state.progress = innerText;
            saveState();
            log(`NEW PROGRESS!\n    ${innerText}`);
            postDiscord(undefined, 0x00ff00, "New progress!", `\`\`\`\n${innerText}\n\`\`\``, progressURL);
        };
    } catch (e) {
        log("error", e);
    };
};

// initializer
const check = async () => {
    await checkNewsletters();
    await checkProgress();
    log("Check complete.");
    setTimeout(check, 60000);
};

(() => {
    log("Hello World!");
    check();
})();