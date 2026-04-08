(function () {
  const STICKY_W = 200;
  const STICKY_H = 200;

  const board = document.getElementById("board");
  const stickySource = document.getElementById("sticky-source");

  /**
   * GitHub Pages (or any static host): set window.BILLBOARD_API_ORIGIN to your deployed Node server,
   * e.g. "https://your-app.onrender.com" — no trailing slash. Empty = same host as the page (local dev).
   */
  function apiOrigin() {
    const o = typeof window.BILLBOARD_API_ORIGIN === "string" ? window.BILLBOARD_API_ORIGIN.trim() : "";
    return o.replace(/\/$/, "");
  }

  function apiUrl(pathname) {
    const base = apiOrigin();
    if (!base) return pathname;
    return base + pathname;
  }

  function wsEndpoint() {
    const base = apiOrigin();
    if (base) {
      const u = new URL(base);
      const wsProto = u.protocol === "https:" ? "wss:" : "ws:";
      return `${wsProto}//${u.host}`;
    }
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}`;
  }

  const notesById = new Map();
  let ws;
  let reconnectTimer;
  let wsOpenedThisAttempt = false;
  let pollTimer = null;

  function randomStickyColor() {
    const h = Math.floor(Math.random() * 360);
    const s = 55 + Math.floor(Math.random() * 30);
    const l = 68 + Math.floor(Math.random() * 18);
    return `hsl(${h} ${s}% ${l}%)`;
  }

  function setNextSourceColor(color) {
    stickySource.style.backgroundColor = color;
  }

  function boardContentRect() {
    const r = board.getBoundingClientRect();
    const cs = getComputedStyle(board);
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const bt = parseFloat(cs.borderTopWidth) || 0;
    const brw = parseFloat(cs.borderRightWidth) || 0;
    const bb = parseFloat(cs.borderBottomWidth) || 0;
    return {
      left: r.left + bl,
      top: r.top + bt,
      width: Math.max(0, r.width - bl - brw),
      height: Math.max(0, r.height - bt - bb),
    };
  }

  function clampNotePosition(x, y) {
    const m = boardContentRect();
    const maxX = Math.max(0, m.width - STICKY_W);
    const maxY = Math.max(0, m.height - STICKY_H);
    return {
      x: Math.min(maxX, Math.max(0, x)),
      y: Math.min(maxY, Math.max(0, y)),
    };
  }

  function clientToBoardLocal(clientX, clientY) {
    const m = boardContentRect();
    return { x: clientX - m.left, y: clientY - m.top };
  }

  function sendToServer(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return;
    }
    fetch(apiUrl("/api/message"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }).catch(() => {});
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function startPolling() {
    if (pollTimer) return;
    async function poll() {
      try {
        const r = await fetch(apiUrl("/api/state"));
        if (!r.ok) return;
        const data = await r.json();
        if (Array.isArray(data.notes)) {
          handleMessage({ type: "init", notes: data.notes });
        }
      } catch {
        /* ignore */
      }
    }
    poll();
    pollTimer = setInterval(poll, 900);
  }

  function noteElement(note) {
    const wrap = document.createElement("div");
    wrap.className = "sticky-note";
    wrap.dataset.noteId = note.id;
    wrap.style.backgroundColor = note.color;
    wrap.style.left = `${note.x}px`;
    wrap.style.top = `${note.y}px`;

    const ta = document.createElement("textarea");
    ta.placeholder = "Type here";
    ta.value = note.text || "";
    ta.spellcheck = true;

    let debounce;
    const sendText = () => {
      sendToServer({ type: "updateNote", id: note.id, text: ta.value });
    };

    ta.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(sendText, 200);
    });

    ta.addEventListener("blur", () => {
      clearTimeout(debounce);
      sendText();
    });

    wrap.appendChild(ta);
    return wrap;
  }

  function upsertNoteElement(note) {
    const existing = notesById.get(note.id);
    if (existing) {
      existing.style.left = `${note.x}px`;
      existing.style.top = `${note.y}px`;
      existing.style.backgroundColor = note.color;
      const ta = existing.querySelector("textarea");
      if (ta && document.activeElement !== ta) ta.value = note.text || "";
      return;
    }
    const el = noteElement(note);
    board.appendChild(el);
    notesById.set(note.id, el);
  }

  function handleMessage(data) {
    if (data.type === "init" && Array.isArray(data.notes)) {
      for (const id of notesById.keys()) {
        const el = notesById.get(id);
        if (el && el.parentNode) el.remove();
      }
      notesById.clear();
      for (const note of data.notes) upsertNoteElement(note);
      return;
    }
    if (data.type === "addNote" && data.note) {
      upsertNoteElement(data.note);
      return;
    }
    if (data.type === "updateNote" && data.id != null) {
      const el = notesById.get(data.id);
      if (!el) return;
      const ta = el.querySelector("textarea");
      if (ta && document.activeElement !== ta) ta.value = data.text || "";
    }
  }

  function connect() {
    wsOpenedThisAttempt = false;
    ws = new WebSocket(wsEndpoint());

    ws.addEventListener("open", () => {
      wsOpenedThisAttempt = true;
      stopPolling();
    });

    ws.addEventListener("message", (ev) => {
      try {
        handleMessage(JSON.parse(ev.data));
      } catch {
        /* ignore */
      }
    });

    ws.addEventListener("close", () => {
      clearTimeout(reconnectTimer);
      if (wsOpenedThisAttempt) {
        reconnectTimer = setTimeout(connect, 1200);
      } else {
        startPolling();
        reconnectTimer = setTimeout(connect, 8000);
      }
    });
  }

  let dragPreview = null;
  let dragging = false;
  let pointerOffsetX = 0;
  let pointerOffsetY = 0;

  function removePreview() {
    if (dragPreview && dragPreview.parentNode) dragPreview.remove();
    dragPreview = null;
  }

  function startDrag(clientX, clientY) {
    const color = stickySource.style.backgroundColor || "red";
    removePreview();
    dragPreview = document.createElement("div");
    dragPreview.className = "drag-preview";
    dragPreview.style.backgroundColor = color;
    document.body.appendChild(dragPreview);

    const rect = stickySource.getBoundingClientRect();
    pointerOffsetX = clientX - rect.left;
    pointerOffsetY = clientY - rect.top;
    movePreview(clientX, clientY);
    dragging = true;
  }

  function movePreview(clientX, clientY) {
    if (!dragPreview) return;
    dragPreview.style.left = `${clientX - pointerOffsetX}px`;
    dragPreview.style.top = `${clientY - pointerOffsetY}px`;
  }

  function endDrag(clientX, clientY) {
    if (!dragging) return;
    dragging = false;
    const m = boardContentRect();
    const inside =
      clientX >= m.left &&
      clientX <= m.left + m.width &&
      clientY >= m.top &&
      clientY <= m.top + m.height;

    const colorUsed = dragPreview ? dragPreview.style.backgroundColor : stickySource.style.backgroundColor;

    removePreview();

    if (!inside) return;

    const local = clientToBoardLocal(clientX - pointerOffsetX, clientY - pointerOffsetY);
    let x = local.x;
    let y = local.y;
    ({ x, y } = clampNotePosition(x, y));

    const note = {
      id: crypto.randomUUID(),
      x,
      y,
      color: colorUsed || randomStickyColor(),
      text: "",
    };

    upsertNoteElement(note);
    sendToServer({ type: "addNote", note });

    setNextSourceColor(randomStickyColor());
  }

  stickySource.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    stickySource.setPointerCapture(e.pointerId);
    startDrag(e.clientX, e.clientY);
  });

  stickySource.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    movePreview(e.clientX, e.clientY);
  });

  stickySource.addEventListener("pointerup", (e) => {
    if (!stickySource.hasPointerCapture(e.pointerId)) return;
    stickySource.releasePointerCapture(e.pointerId);
    endDrag(e.clientX, e.clientY);
  });

  stickySource.addEventListener("pointercancel", (e) => {
    if (stickySource.hasPointerCapture(e.pointerId)) {
      stickySource.releasePointerCapture(e.pointerId);
    }
    dragging = false;
    removePreview();
  });

  setNextSourceColor("red");
  connect();
})();
