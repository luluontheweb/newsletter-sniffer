import { Client, Events, GatewayIntentBits, ActivityType, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags } from 'discord.js';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from "fs";
import { AtpAgent, RichText } from '@atproto/api';
import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import puppeteer from "puppeteer";
import Emusks from "emusks";
import axios from "axios";

// constants
const newslettersURL = "https://toby.fangamer.com";
const progressURL = "https://deltarune.com/7b/";
const twitterAccounts = { "39157744": "Toby Fox", "1148644417": "UNDERTALE/DELTARUNE" };
const bskyAccounts = { "did:plc:vshnclkqqguyg6xcz6q7g65k": "Toby Fox", "did:plc:ac4wblywohiikyarecf3ddpc": "UNDERTALE/DELTARUNE" };
const baseState = { newsletters: [], progress: null, twitter: {}, bsky: {}, rolesMessage: null };

// essentials
const config = JSON.parse(readFileSync("config.json", "utf8"));
const state = existsSync("state.json") ? { ...baseState, ...JSON.parse(readFileSync("state.json", "utf8")) } : baseState;
let changesMade = false;
const saveState = () => {
    writeFileSync("state.json", JSON.stringify(state, null, 2));
    changesMade = false;
};
const sha256sum = data => createHash('sha256').update(data).digest('hex');
const log = (data, error) => {
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
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
const channels = {};
const getChannel = async (id) => {
    if (channels[id]) return channels[id];
    const channel = await client.channels.fetch(id);
    channels[id] = channel;
    return channel;
};
client.on(Events.ClientReady, async () => {
    try {
        log(`Logged into Discord as ${client.user.tag}!`)
        client.user.setActivity('stalking Toby Fox 👀', { type: ActivityType.Watching });
        const channel = await getChannel(config.channels.info);
        if (state.rolesMessage) {
            try {
                const message = await channel.messages.fetch(state.rolesMessage);
                if (message) return;
            } catch (e) {
                log("Roles message no longer exists, recreating", e);
            };
        };
        const row = new ActionRowBuilder();
        for (const role in config.roles) {
            const [_, emoji] = config.roles[role];
            const button = new ButtonBuilder()
                .setCustomId(role)
                .setLabel(role)
                .setEmoji(emoji)
                .setStyle(ButtonStyle.Success);
            row.addComponents(button);
        };
        const message = await channel.send({ content: "come get yo roles yall\n> by default, you receive all notifications, feel free to remove/add any!", components: [row] });
        state.rolesMessage = message.id;
        changesMade = true;
    } catch (e) {
        log("Failed to start Discord bot", e);
    };
});
client.on(Events.GuildMemberAdd, async member => {
    try {
        const channel = await getChannel(config.channels.logs);
        const embed = new EmbedBuilder()
            .setColor(0x40ff40)
            .setDescription(`<@${member.id}> (\`${member.id}\`) joined!`);
        await channel.send({ embeds: [embed] });
        await member.roles.add(Object.values(config.roles).map(r => r[0]), "joined");
    } catch (e) {
        log("Failed to log user joining", e);
    };
});
client.on(Events.GuildMemberRemove, async member => {
    try {
        const channel = await getChannel(config.channels.logs);
        const embed = new EmbedBuilder()
            .setColor(0xff4040)
            .setDescription(`**${member.user.username}** (\`${member.id}\`) left.`);
        await channel.send({ embeds: [embed] });
    } catch (e) {
        log("Failed to log user leaving", e);
    };
});
client.on(Events.InteractionCreate, async interaction => {
    try {
        if (!interaction.isButton()) return;
        const role = interaction.customId;
        if (!config.roles[role]) return;
        const [roleId, _] = config.roles[role];
        const member = interaction.member;
        if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId, "requested");
            const embed = new EmbedBuilder()
                .setColor(0xff4040)
                .setDescription(`<@&${roleId}> removed!`);
            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        } else {
            await member.roles.add(roleId, "requested");
            const embed = new EmbedBuilder()
                .setColor(0x40ff40)
                .setDescription(`<@&${roleId}> added!`);
            await interaction.reply({ embeds: [embed], flags: [MessageFlags.Ephemeral] });
        };
    } catch (e) {
        log("Failed to add/remove role", e);
    };
});

// twitter & bluesky
const twitter = new Emusks();
const bsky = new AtpAgent({ service: 'https://bsky.social' });
const queue = [];
let handler = null;
const post = (content, media, socials = ["twitter", "bluesky"]) => {
    queue.push({ content, media, socials });
    if (!handler) handler = (async () => {
        while (queue.length > 0) {
            log(`Queue size: ${queue.length}`);
            const { content, media, socials } = queue.shift();
            const image = media ? readFileSync(media) : undefined;
            if (socials.includes("twitter")) {
                try {
                    const mediaIds = [];
                    if (media) {
                        const twitterMedia = await twitter.media.create(image);
                        mediaIds.push(twitterMedia.media_id);
                    };
                    const response = await twitter.tweets.create(content, { mediaIds });
                    log(`Tweeted! ${response.id}`);
                } catch (err) {
                    log("Failed to tweet", err);
                };
            };
            if (socials.includes("bluesky")) {
                try {
                    const rt = new RichText({ text: content, });
                    await rt.detectFacets(bsky);
                    const record = {
                        text: rt.text,
                        facets: rt.facets
                    };
                    if (media) {
                        const upload = await bsky.uploadBlob(image, { encoding: "image/png" });
                        record.embed = {
                            $type: 'app.bsky.embed.images',
                            images: [{ image: upload.data.blob, alt: "" }]
                        };
                    };
                    const response = await bsky.post(record);
                    log(`Posted to Bluesky! ${response.uri}`);
                } catch (err) {
                    log("Failed to post to Bluesky", err);
                };
            };
            await sleep(60);
        };
        log(`Queue empty!`);
        handler = null;
    })();
};

// scrapers
const checkNewsletters = async () => {
    log("Checking for new newsletters...");
    try {
        const newslettersPage = await axios.get(`${newslettersURL}/newsletters`);
        const $ = cheerio.load(newslettersPage.data);
        for (const article of $("#articles").children().get().reverse()) {
            const href = article.attribs['href'];
            if (!state.newsletters.includes(href)) {
                const url = `${newslettersURL}${href}`;
                const [title, description] = $(article).text().split('\n').map(s => s.trim()).filter(Boolean);
                log(`NEW NEWSLETTER! ${url}\n    ${title}\n    ${description}`);
                const channel = await getChannel(config.channels.newsletters);
                const msg = await channel.send(`# New newsletter! ✉️\n**${url}**\n-# ||<@&${config.roles.newsletters[0]}>||`);
                msg.crosspost().catch(() => { });
                post(`New Toby Fox newsletter! #deltarune\n${url}`);
                state.newsletters.push(href);
                changesMade = true;
            };
        };
    } catch (e) {
        log("Error checking newsletters", e);
    };
};

const checkProgress = async () => {
    log("Checking for progress...");
    try {
        const progressPage = await axios.get(progressURL).then(r => r.data);
        const progressSha256 = sha256sum(progressPage);
        if (progressSha256 !== state.progress) {
            log(`NEW PROGRESS!`);
            async function screenshot(progress = () => { }) {
                progress("launching...");
                const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
                try {
                    progress("opening page...");
                    const page = await browser.newPage();
                    progress("setting viewport...");
                    await page.setViewport({ width: 540, height: 720 });
                    progress("going to page...");
                    await page.goto(progressURL, { waitUntil: 'networkidle2' });
                    progress("taking screenshot...");
                    await page.screenshot({ path: './progress.png', fullPage: true });
                    progress('screenshot saved!');
                } finally {
                    progress("closing browser...");
                    await browser.close();
                };
            };
            await screenshot(log);
            const channel = await getChannel(config.channels.progress);
            const message = await channel.send({ content: `# [New 7B progress!](${progressURL})\n-# ||<@&${config.roles.progress[0]}>||`, files: ["./progress.png"] });
            message.crosspost().catch(() => { });
            post(`New 7B progress! #deltarune\n${progressURL}`, "./progress.png");
            state.progress = progressSha256;
            changesMade = true;
        };
    } catch (e) {
        log("Error checking progress", e);
    };
};

const checkTwitter = async () => {
    for (const account in twitterAccounts) {
        log(`Checking for ${twitterAccounts[account]} Twitter activity...`);
        try {
            const { tweets = [] } = (await twitter.users.replies(account)) || {};
            if (!state.twitter[account]) state.twitter[account] = [];
            for (let i = tweets.length - 1; i >= 0; i--) {
                const tweet = tweets[i];
                if (String(tweet.user?.id) === account && Date.now() - new Date(tweet.created_at).getTime() < config.maxage * 1000 && !state.twitter[account].includes(tweet.id)) {
                    log(`NEW TWEET BY ${twitterAccounts[account]}! https://x.com/i/status/${tweet.id}`);
                    const channel = await getChannel(config.channels.twitter);
                    const message = await channel.send(`# New Tweet by ${twitterAccounts[account]}!\n**https://x.com/i/status/${tweet.id}**\n-# ||<@&${config.roles.twitter[0]}>||`);
                    message.crosspost().catch(() => { });
                    await twitter.tweets.retweet(tweet.id);
                    post(`New tweet by ${twitterAccounts[account]}! #deltarune\nhttps://x.com/i/status/${tweet.id}`, undefined, ["bluesky"]);
                    state.twitter[account].push(tweet.id);
                    changesMade = true;
                };
            };
        } catch (e) {
            log("Error checking Twitter", e);
        };
    };
};

const checkBluesky = async () => {
    for (const account in bskyAccounts) {
        log(`Checking for ${bskyAccounts[account]} Bluesky activity...`);
        try {
            const authorFeed = await bsky.getAuthorFeed({ actor: account });
            const posts = authorFeed.data?.feed ?? [];
            if (!state.bsky[account]) state.bsky[account] = [];
            for (let i = posts.length - 1; i >= 0; i--) {
                const entry = posts[i];
                if (entry.post?.author?.did === account && Date.now() - new Date(entry.post?.indexedAt).getTime() < config.maxage * 1000 && !state.bsky[account].includes(entry.post?.uri)) {
                    const postURL = `https://bsky.app/profile/${entry.post?.author?.handle}/post/${entry.post?.uri.split('/').pop()}`;
                    log(`NEW BLUESKY POST BY ${bskyAccounts[account]}! ${postURL}`);
                    const channel = await getChannel(config.channels.bluesky);
                    const message = await channel.send(`# New Bluesky post by ${bskyAccounts[account]}!\n**${postURL}**\n-# ||<@&${config.roles.bluesky[0]}>||`);
                    message.crosspost().catch(() => { });
                    await bsky.repost(entry.post.uri, entry.post.cid);
                    post(`New Bluesky post by ${bskyAccounts[account]}! #deltarune\n${postURL}`, undefined, ["twitter"]);
                    state.bsky[account].push(entry.post?.uri);
                    changesMade = true;
                };
            };
        } catch (e) {
            log("Error checking Bluesky", e);
        };
    };
};

// initializer
const check = async () => {
    try {
        await checkNewsletters();
        await checkProgress();
        await checkTwitter();
        await checkBluesky();
        log("All checks completed.");
    } catch (e) {
        log("Error in check loop", e);
    } finally {
        if (changesMade) saveState();
        setTimeout(check, config.interval * 1000);
    };
};

(async () => {
    log("Hello World!");
    await client.login(process.env.DISCORD_TOKEN);
    await twitter.login(process.env.TWITTER_AUTH);
    await bsky.login({ identifier: process.env.BSKY_HANDLE, password: process.env.BSKY_PASSWORD });
    check();
})();