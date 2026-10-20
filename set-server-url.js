#!/usr/bin/env node
// Usage: node set-server-url.js path/to/game.html https://your-server.example.com [output.html]
// Writes the multiplayer server address into the game's VOID_CONFIG.
const fs = require('fs');
const [,, file, url, out] = process.argv;
if (!file || !url) { console.error('Usage: node set-server-url.js game.html https://your-server.example.com [output.html]'); process.exit(1); }
let u; try { u = new URL(url); } catch { console.error('Not a valid URL: ' + url); process.exit(1); }
if (u.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/.test(u.hostname)) { console.error('CrazyGames needs an https:// server address.'); process.exit(1); }
let html = fs.readFileSync(file, 'utf8');
const re = /multiplayerUrl:"[^"]*"/;
if (!re.test(html)) { console.error('Could not find multiplayerUrl in VOID_CONFIG.'); process.exit(1); }
html = html.replace(re, 'multiplayerUrl:' + JSON.stringify(u.origin));
const dest = out || file.replace(/\.html$/, '') + '.mp.html';
fs.writeFileSync(dest, html);
console.log('Wrote ' + dest + ' with multiplayerUrl = ' + u.origin);
