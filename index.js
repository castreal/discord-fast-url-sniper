const WebSocket = require('ws');
const tls = require('tls');
const extractJson = require('extract-json-string');
const fs = require('fs');
const { performance } = require('perf_hooks');

const config = {
    token: "",
    serverid: "",
    logChannelId: ""
};

let guilds = {};
let lastSeq = null;
let hbInterval = null;
let mfaToken = null;
let mfaTokenLastChecked = 0;
let lastMfaFileTime = 0;
const tlsSessionCache = new Map();
const tlsOptions = {
    host: 'canary.discord.com',
    port: 443,
    rejectUnauthorized: false,
    timeout: 2000,
    keepAlive: true,
    secureProtocol: 'TLSv1_3_method',
    ciphers: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-RSA-AES256-GCM-SHA384',
    honorCipherOrder: true,
    sessionTimeout: 30000,
};

async function sendLog(message) {
    try {
        await req("POST", `/api/v7/channels/${config.logChannelId}/messages`, JSON.stringify({
            content: message
        }));
    } catch (e) {}
}

function safeExtract(d) {
    if (typeof d !== 'string') {
        try {
            return JSON.stringify(d);
        } catch (e) {
            return null;
        }
    }
    const result = extractJson.extract(d, { maxDepth: 2 });
    return result || null;
}

function readMfaToken(force = false) {
    const now = Date.now();
    if (!force && now - mfaTokenLastChecked < 10000) {
        return mfaToken;
    }
    try {
        const stats = fs.statSync('mfa.txt', { throwIfNoEntry: false });
        if (!stats || (!force && mfaToken && stats.mtimeMs <= lastMfaFileTime)) {
            return mfaToken;
        }

        lastMfaFileTime = stats.mtimeMs;
        const data = fs.readFileSync('mfa.txt', 'utf8');
        const tokenFromFile = data.trim();

        if (tokenFromFile) {
            mfaToken = tokenFromFile;
            mfaTokenLastChecked = now;
            return mfaToken;
        }
    } catch (e) {}
    return mfaToken;
}

async function req(method, path, body = null) {
    return new Promise(resolve => {
        const sessionId = tlsSessionCache.get('canary.discord.com');
        const socketOptions = { ...tlsOptions };
        if (sessionId) {
            socketOptions.session = sessionId;
        }

        const socket = tls.connect(socketOptions, () => {
            const headers = [
                `${method} ${path} HTTP/1.1`,
                'Host: canary.discord.com',
                `Authorization: ${config.token}`,
                'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
                'X-Super-Properties: eyJvcyI6IldpbmRvd3MiLCJicm93c2VyIjoiRmlyZWZveCIsImRldmljZSI6IiIsInN5c3RlbV9sb2NhbGUiOiJ0ci1UUiIsImJyb3dzZXJfdXNlcl9hZ2VudCI6Ik1vemlsbGEvNS4wIChXaW5kb3dzIE5UIDEwLjA7IFdpbjY0OyB4NjQ7IHJ2OjEzMy4wKSBHZWNrby8yMDEwMDEwMSBGaXJlZm94LzEzMy4wIiwiYnJvd3Nlcl92ZXJzaW9uIjoiMTMzLjAiLCJvc192ZXJzaW9uIjoiMTAiLCJyZWZlcnJlciI6Imh0dHBzOi8vd3d3Lmdvb2dsZS5jb20vIn0='
            ];

            if (mfaToken) {
                headers.push(`X-Discord-MFA-Authorization: ${mfaToken}`);
            }
            if (body) {
                headers.push('Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`);
            }
            headers.push('Connection: keep-alive', '', body || ''); 
            socket.write(headers.join('\r\n'));

            let data = '';
            socket.on('data', chunk => data += chunk.toString());

            socket.on('end', () => {
                const headerEnd = data.indexOf('\r\n\r\n');
                if (headerEnd === -1) {
                    resolve('{}');
                    return socket.destroy();
                }

                let responseBody = data.slice(headerEnd + 4);
                if (data.toLowerCase().includes('transfer-encoding: chunked')) {
                    let result = '';
                    let offset = 0;
                    while (offset < responseBody.length) {
                        const end = responseBody.indexOf('\r\n', offset);
                        if (end === -1) break;
                        const size = parseInt(responseBody.substring(offset, end), 16);
                        if (size === 0) break;
                        result += responseBody.substring(end + 2, end + 2 + size);
                        offset = end + 2 + size + 2;
                    }
                    responseBody = result || '{}';
                }

                if (!path.includes('/vanity-url')) {
                    const extracted = safeExtract(responseBody);
                    if (extracted) {
                        resolve(extracted);
                        return socket.destroy();
                    }
                }
                resolve(responseBody);
                socket.destroy();

                const session = socket.getSession();
                if (session) {
                    tlsSessionCache.set('canary.discord.com', session);
                }
            });

            socket.on('error', () => {
                resolve('{}');
                socket.destroy();
            });
        });

        socket.setTimeout(200, () => {
            resolve('{}');
            socket.destroy();
        });
    });
}

function connect() {
    req("GET", "/api/v7/gateway").then(res => {
        let url;
        try {
            url = JSON.parse(res)?.url;
        } catch (e) {
            const extracted = safeExtract(res);
            if (extracted) {
                try {
                    url = JSON.parse(extracted)?.url;
                } catch (e) {}
            }
        }

        const ws = new WebSocket(url || "wss://gateway.discord.gg/?v=9&encoding=json", {
            perMessageDeflate: false, 
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
            },
        });

        ws.on("open", () => {
            ws.send(JSON.stringify({
                op: 2,
                d: {
                    token: config.token,
                    intents: 513,
                    properties: {
                        os: "Linux",
                        browser: "Firefox",
                        device: "Allah"
                    }
                }
            }));
        });

        ws.on("message", async data => {
            try {
                let payload;
                try {
                    payload = typeof data === 'string' ? JSON.parse(data) : JSON.parse(data.toString('utf8'));
                } catch (e) {
                    const extracted = safeExtract(data.toString('utf8'));
                    if (extracted) {
                        payload = JSON.parse(extracted);
                    } else {
                        return;
                    }
                }
                if (payload.s) lastSeq = payload.s;
                if (payload.op === 10) {
                    clearInterval(hbInterval);
                    const interval = payload.d.heartbeat_interval;
                    hbInterval = setInterval(() => {
                        ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                    }, interval - 50); 
                }
                if (payload.t === "READY") {
                    payload.d.guilds.filter(g => g.vanity_url_code).forEach(g => {
                        guilds[g.id] = {
                            code: g.vanity_url_code,
                            name: g.name
                        };
                    });
                }
                if (payload.t === "GUILD_UPDATE") {
                    const id = payload.d.id || payload.d.guild_id;
                    const oldGuild = guilds[id];
                    const newCode = payload.d.vanity_url_code;
                    const guildName = payload.d.name;
                    if (oldGuild && oldGuild.code !== newCode) {
                        readMfaToken();
                        if (mfaToken) {
                            const patchPayload = JSON.stringify({ code: oldGuild.code });
                            const promises = [
                                req("PATCH", `/api/v7/guilds/${config.serverid}/vanity-url`, patchPayload),
                                req("PATCH", `/api/v8/guilds/${config.serverid}/vanity-url`, patchPayload),
                                req("PATCH", `/api/v10/guilds/${config.serverid}/vanity-url`, patchPayload),
                                req("PATCH", `/api/guilds/${config.serverid}/vanity-url`, patchPayload)
                            ];
                            const startTime = performance.now();
                            await Promise.all(promises);
                            const endTime = performance.now();

                            sendLog(`${oldGuild.code} @everyone`);
                        }
                    }
                    if (newCode) {
                        guilds[id] = {
                            code: newCode,
                            name: guildName
                        };
                    } else if (guilds[id]) {
                        delete guilds[id];
                    }
                }
                if (payload.t === "GUILD_DELETE") {
                    const deletedGuild = guilds[payload.d.id];
                    if (deletedGuild) {
                        readMfaToken();
                        if (mfaToken) {
                            const patchPayload = JSON.stringify({ code: deletedGuild.code });
                            const promises = [
                                req("PATCH", `/api/v7/guilds/${config.serverid}/vanity-url`, patchPayload),
                                req("PATCH", `/api/v8/guilds/${config.serverid}/vanity-url`, patchPayload),
                                req("PATCH", `/api/v10/guilds/${config.serverid}/vanity-url`, patchPayload)
                            ];
                            const startTime = performance.now();
                            await Promise.all(promises);
                            const endTime = performance.now();

                        
                        }
                        delete guilds[payload.d.id];
                    }
                }
            } catch (e) {
                console.error("Error:", e.message);
            }
        });
        ws.on("close", () => {
            clearInterval(hbInterval);
            setTimeout(connect, 200);
        });
        ws.on("error", () => ws.close());
    }).catch(() => setTimeout(connect, 200));
}

(async () => {
    readMfaToken(true);
    connect();
    setInterval(() => readMfaToken(false), 15000);
})();
process.on('uncaughtException', (e) => {
    console.error("Unexpected error:", e.message);
});
