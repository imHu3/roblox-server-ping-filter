// content.js
console.log("Roblox Server Ping Filter extension loaded.");

let placeId = null;
let currentValidServers = [];
let currentPage = 1;
const SERVERS_PER_PAGE = 12;
let cachedRawServers = [];
let lastFetchTime = 0;

function extractPlaceId() {
    const urlMatch = window.location.href.match(/games\/(\d+)/);
    return urlMatch ? urlMatch[1] : null;
}

function init() {
    // Continuously observe because Roblox is a Single Page App
    // and destroys/creates DOM elements when changing tabs
    const observer = new MutationObserver((mutations) => {
        const currentPlaceId = extractPlaceId();
        if (currentPlaceId) {
            placeId = currentPlaceId;
            // Target elements where Servers list usually appears
            const targetContainer = document.getElementById('rbx-public-running-games') || document.getElementById('rbx-running-games') || document.querySelector('.rbx-running-games-container') || document.querySelector('.game-instances-container');

            if (targetContainer && !document.getElementById('ping-filter-container')) {
                injectUI(targetContainer);
            }
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });
}

init();

function injectUI(targetContainer) {
    if (document.getElementById('ping-filter-container')) return;

    const container = document.createElement('div');
    container.id = 'ping-filter-container';

    container.innerHTML = `
        <div class="ping-filter-header">
            <div class="ping-filter-title">Servers by Ping</div>
            <div class="ping-filter-controls">
                <label for="ping-filter-max">Max Ping (ms):</label>
                <input type="number" id="ping-filter-max" class="ping-filter-input" placeholder="e.g. 100" value="100" />
                <button id="ping-filter-refresh" class="ping-filter-btn">Search Servers</button>
            </div>
        </div>
        <div id="ping-filtered-status" class="ping-status-text">Ready to search servers.</div>
        <div id="ping-filtered-servers"></div>
        <div id="ping-pagination-container" class="ping-filter-pagination" style="display: none;">
            <button id="ping-prev-page" class="ping-filter-btn">Previous</button>
            <span id="ping-page-info">Page 1</span>
            <button id="ping-next-page" class="ping-filter-btn">Next</button>
        </div>
    `;

    // Inject before the native servers list
    targetContainer.parentNode.insertBefore(container, targetContainer);

    document.getElementById('ping-filter-refresh').addEventListener('click', handleSearch);
    document.getElementById('ping-prev-page').addEventListener('click', () => {
        if (currentPage > 1) {
            currentPage--;
            renderPage();
        }
    });
    document.getElementById('ping-next-page').addEventListener('click', () => {
        const totalPages = Math.ceil(currentValidServers.length / SERVERS_PER_PAGE);
        if (currentPage < totalPages) {
            currentPage++;
            renderPage();
        }
    });
}

async function handleSearch() {
    const btn = document.getElementById('ping-filter-refresh');
    const statusText = document.getElementById('ping-filtered-status');
    const maxPing = parseInt(document.getElementById('ping-filter-max').value, 10) || 100;
    const serversList = document.getElementById('ping-filtered-servers');
    const paginationContainer = document.getElementById('ping-pagination-container');

    btn.disabled = true;
    serversList.innerHTML = '';
    paginationContainer.style.display = 'none';
    statusText.innerText = 'Searching servers... (this may find many pages)';

    try {
        currentValidServers = await fetchServersWithPingLimit(maxPing);
        currentPage = 1;

        if (currentValidServers.length === 0) {
            statusText.innerText = `No servers found with ping < ${maxPing}ms. Try increasing the limit or try again later.`;
        } else {
            statusText.innerText = `Found ${currentValidServers.length} servers matching your criteria.`;
            await renderPage();
        }
    } catch (err) {
        if (err.message === "429") {
            statusText.innerText = 'Rate limited by Roblox API. Please wait a few seconds and try again.';
        } else {
            statusText.innerText = 'Error fetching servers. See console.';
            console.error(err);
        }
    } finally {
        btn.disabled = false;
    }
}

async function renderPage() {
    const serversList = document.getElementById('ping-filtered-servers');
    const paginationContainer = document.getElementById('ping-pagination-container');
    const pageInfo = document.getElementById('ping-page-info');
    const prevBtn = document.getElementById('ping-prev-page');
    const nextBtn = document.getElementById('ping-next-page');

    const totalPages = Math.ceil(currentValidServers.length / SERVERS_PER_PAGE);

    paginationContainer.style.display = 'flex';
    pageInfo.innerText = `Loading...`;
    prevBtn.disabled = true;
    nextBtn.disabled = true;

    serversList.innerHTML = '';

    const startIdx = (currentPage - 1) * SERVERS_PER_PAGE;
    const endIdx = startIdx + SERVERS_PER_PAGE;
    const serversToRender = currentValidServers.slice(startIdx, endIdx);

    await renderServers(serversToRender, serversList);

    pageInfo.innerText = `Page ${currentPage} / ${totalPages || 1}`;
    paginationContainer.style.display = totalPages > 1 ? 'flex' : 'none';
    prevBtn.disabled = currentPage === 1;
    nextBtn.disabled = currentPage === totalPages;
}

async function fetchServersWithPingLimit(maxPing) {
    const CACHE_TTL = 30000; // 30 seconds cooldown/cache to prevent rate limiting
    const now = Date.now();

    if (now - lastFetchTime < CACHE_TTL && cachedRawServers.length > 0) {
        console.log("Using cached servers to avoid rate limit");
        const valid = cachedRawServers.filter(s => s.ping !== undefined && s.ping <= maxPing && s.playing < s.maxPlayers);
        valid.sort((a, b) => a.ping - b.ping);
        return valid;
    }

    let allServers = [];
    let cursor = '';

    // Fetch up to 4 pages to prevent aggressive rate limits
    for (let i = 0; i < 4; i++) {
        let url = `https://games.roblox.com/v1/games/${placeId}/servers/Public?sortOrder=Asc&limit=100`;
        if (cursor) url += `&cursor=${cursor}`;

        const res = await fetch(url, { credentials: 'include' });
        if (res.status === 429) {
            if (allServers.length > 0) break; // Return what we have
            throw new Error("429");
        }
        if (!res.ok) break;

        const data = await res.json();

        if (data.data) {
            allServers = allServers.concat(data.data);
        }

        if (data.nextPageCursor) {
            cursor = data.nextPageCursor;
        } else {
            break;
        }

        // Delay between page requests to avoid 429
        await new Promise(r => setTimeout(r, 400));
    }

    cachedRawServers = allServers;
    lastFetchTime = Date.now();

    const valid = allServers.filter(s => s.ping !== undefined && s.ping <= maxPing && s.playing < s.maxPlayers);
    valid.sort((a, b) => a.ping - b.ping);
    return valid;
}

async function fetchPlayerHeadshots(tokens) {
    if (!tokens || tokens.length === 0) return [];
    try {
        const body = tokens.map(token => ({
            requestId: token,
            token: token,
            type: "AvatarHeadshot",
            size: "48x48",
            format: "png",
            isCircular: true
        }));

        const res = await fetch('https://thumbnails.roblox.com/v1/batch', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });

        if (!res.ok) return [];
        const data = await res.json();
        return data.data || [];
    } catch (e) {
        console.error("Failed to fetch thumbnails:", e);
        return [];
    }
}

async function renderServers(servers, container) {
    for (const server of servers) {
        const card = document.createElement('div');

        let pingClass = 'good-ping';
        if (server.ping > 150) pingClass = 'bad-ping';
        else if (server.ping > 80) pingClass = 'medium-ping';

        card.className = `ping-server-card ${pingClass}`;

        // Fetch thumbnails for the first 8 players to avoid overloading
        const tokensToFetch = (server.playerTokens || (server.players ? server.players.map(p => p.playerToken) : [])).filter(t => t).slice(0, 8);
        const headshots = await fetchPlayerHeadshots(tokensToFetch);

        let avatarsHtml = '';
        headshots.forEach(hs => {
            if (hs.imageUrl) {
                avatarsHtml += `<img src="${hs.imageUrl}" class="ping-avatar" title="Player" />`;
            } else {
                avatarsHtml += `<div class="ping-avatar-placeholder"></div>`;
            }
        });

        const totalPlayersCount = server.playerTokens ? server.playerTokens.length : (server.players ? server.players.length : 0);
        if (totalPlayersCount > 8) {
            avatarsHtml += `<span style="font-size: 12px; color: #bdbebe; align-self: center; margin-left: 4px;">+${totalPlayersCount - 8}</span>`;
        }

        card.innerHTML = `
            <div class="ping-server-info" style="margin-bottom: 8px;">
                <span><strong>Ping:</strong> ${server.ping}ms</span>
                <span>${server.playing} / ${server.maxPlayers} Players</span>
            </div>
            <div class="ping-avatars-container">
                ${avatarsHtml}
            </div>
            <button class="ping-server-join" data-server="${server.id}">Join</button>
        `;

        // Join click handler (Deep link fallback via window location)
        card.querySelector('.ping-server-join').addEventListener('click', () => {
            joinServer(server.id);
        });

        container.appendChild(card);
    }
}

function joinServer(serverId) {
    console.log("Joining server:", serverId);
    // Bypass CSP limits by launching via Deep Link Protocol directly from Content Script context
    window.location.assign(`roblox://experiences/start?placeId=${placeId}&gameInstanceId=${serverId}`);
}
