/* Notes2Quiz — © 2026 P Om Shiva. All rights reserved.
   Copying or reusing this code without written permission is not allowed. */
(() => {
  "use strict";

  const SAMPLE_NOTES = `Computer Networks — Unit 1 notes

A computer network connects devices so they can share data and resources. Networks are grouped by size: a LAN covers a small area like a lab or a home, a MAN covers a city, and a WAN covers countries. The Internet is the largest WAN.

The OSI model has seven layers: Physical, Data Link, Network, Transport, Session, Presentation and Application. The TCP/IP model is the practical model used on the Internet and has four layers.

The Physical layer sends raw bits over cables or radio. The Data Link layer uses MAC addresses to move frames inside one network; a switch works at this layer. The Network layer uses IP addresses to route packets between different networks; a router works at this layer.

TCP is connection-oriented and reliable: it starts with a three-way handshake (SYN, SYN-ACK, ACK), numbers every segment and resends lost ones. UDP is connectionless and faster but does not guarantee delivery, so it suits live video, online games and DNS lookups.

An IPv4 address is 32 bits long, written as four numbers such as 192.168.1.10. IPv6 addresses are 128 bits long; IPv6 was created because IPv4 addresses were running out.

DNS works like the phonebook of the Internet: it turns a name such as example.com into an IP address. HTTP is used to load web pages. HTTPS is HTTP with TLS encryption and uses port 443, while plain HTTP uses port 80.

A firewall filters traffic using rules and blocks unwanted connections. Bandwidth is the maximum data rate of a link, and latency is the delay for data to travel from source to destination.`;

  const SECONDS = 30;
  const LETTERS = ["A", "B", "C", "D"];
  const $ = (id) => document.getElementById(id);

  const state = {
    source: "text",        // text | pdf | photo
    pdfText: "",
    photo: "",              // data URL
    quiz: null,
    i: 0,
    picks: [],              // index picked per question, -1 = time ran out
    timerOn: true,
    timerId: null,
    left: SECONDS,
  };

  // ---------- views ----------
  function show(view) {
    for (const v of ["home", "loading", "quiz", "results"]) $(`view-${v}`).hidden = v !== view;
    $("why").hidden = view === "quiz" || view === "loading";
    window.scrollTo({ top: 0 });
  }

  // ---------- input tabs ----------
  const tabs = ["text", "pdf", "photo"];
  function selectTab(name) {
    state.source = name;
    for (const t of tabs) {
      $(`tab-${t}`).setAttribute("aria-selected", String(t === name));
      $(`panel-${t}`).hidden = t !== name;
    }
    $("form-error").hidden = true;
  }
  tabs.forEach((t, idx) => {
    const el = $(`tab-${t}`);
    el.addEventListener("click", () => selectTab(t));
    el.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      const next = tabs[(idx + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(next); $(`tab-${next}`).focus();
    });
  });

  const notes = $("notes");
  const updateCount = () => { $("char-count").textContent = `${notes.value.length.toLocaleString()} characters`; };
  notes.addEventListener("input", updateCount);
  $("use-sample").addEventListener("click", () => { notes.value = SAMPLE_NOTES; updateCount(); notes.focus(); });

  // ---------- PDF ----------
  $("pdf-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    state.pdfText = ""; state.photo = "";
    if (!file) return;
    const status = $("pdf-status");
    status.textContent = `Reading ${file.name}…`;
    try {
      const lib = window.pdfjsLib;
      lib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
      const pdf = await lib.getDocument({ data: await file.arrayBuffer() }).promise;
      const pages = Math.min(pdf.numPages, 30);
      let text = "";
      for (let p = 1; p <= pages; p++) {
        const page = await pdf.getPage(p);
        const content = await page.getTextContent();
        text += content.items.map((it) => it.str).join(" ") + "\n\n";
      }
      text = text.replace(/[ \t]+/g, " ").trim();
      if (text.length >= 200) {
        state.pdfText = text;
        status.textContent = `Ready: ${pages} page${pages > 1 ? "s" : ""}, ${text.length.toLocaleString()} characters of text.`;
      } else {
        // Scanned PDF: send the first page as a picture instead.
        const page = await pdf.getPage(1);
        const vp = page.getViewport({ scale: 1.6 });
        const canvas = document.createElement("canvas");
        canvas.width = vp.width; canvas.height = vp.height;
        await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
        state.photo = canvas.toDataURL("image/jpeg", 0.85);
        status.textContent = "This looks like a scanned PDF, so page 1 will be read as a photo.";
      }
    } catch {
      status.textContent = "Couldn't read that PDF. Try another file, or paste the text instead.";
    }
  });

  // ---------- Photo ----------
  $("photo-input").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    state.photo = "";
    if (!file) return;
    $("photo-status").textContent = "Preparing photo…";
    try {
      const img = await loadImage(URL.createObjectURL(file));
      const scale = Math.min(1, 1600 / Math.max(img.width, img.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale); canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      state.photo = canvas.toDataURL("image/jpeg", 0.85);
      const prev = $("photo-preview"); prev.src = state.photo; prev.hidden = false;
      $("photo-status").textContent = "Photo ready.";
    } catch {
      $("photo-status").textContent = "Couldn't open that photo. Try a JPG or PNG.";
    }
  });
  const loadImage = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });

  // ---------- make quiz ----------
  const loadingLines = ["Reading your notes…", "Finding the key ideas…", "Writing your questions…", "Checking the answers…"];
  let loadingTimer = null;

  $("quiz-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const err = $("form-error");
    err.hidden = true;
    const level = document.querySelector('input[name="level"]:checked').value;
    const count = Number(document.querySelector('input[name="count"]:checked').value);
    state.timerOn = $("timer-on").checked;

    const payload = { level, count };
    if (state.source === "text") payload.text = notes.value.trim();
    if (state.source === "pdf") { payload.text = state.pdfText; payload.image = state.photo || undefined; }
    if (state.source === "photo") payload.image = state.photo;

    if (!payload.image && (!payload.text || payload.text.length < 200)) {
      err.textContent = state.source === "text"
        ? "Add a bit more — at least a paragraph of notes (200+ characters)."
        : state.source === "pdf" ? "Choose a PDF first." : "Take or choose a photo first.";
      err.hidden = false;
      return;
    }

    show("loading");
    let n = 0;
    $("loading-text").textContent = loadingLines[0];
    loadingTimer = setInterval(() => { n = Math.min(n + 1, loadingLines.length - 1); $("loading-text").textContent = loadingLines[n]; }, 2200);

    try {
      const r = await fetch("api/quiz", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || "Couldn't make a quiz right now. Please try again.");
      startQuiz(data);
    } catch (ex) {
      show("home");
      err.textContent = ex.message;
      err.hidden = false;
    } finally {
      clearInterval(loadingTimer);
    }
  });

  // ---------- quiz ----------
  function startQuiz(quiz) {
    state.quiz = quiz;
    state.i = 0;
    state.picks = [];
    $("quiz-title").textContent = quiz.title;
    show("quiz");
    renderQuestion();
  }

  function renderQuestion() {
    const { questions } = state.quiz;
    const q = questions[state.i];
    $("q-count").textContent = `Question ${state.i + 1} of ${questions.length}`;
    $("bar-fill").style.width = `${(state.i / questions.length) * 100}%`;
    $("q-text").textContent = q.question;
    const list = $("answers");
    list.textContent = "";
    q.options.forEach((opt, k) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "answer";
      b.dataset.k = k;
      const bub = document.createElement("span");
      bub.className = "bubble"; bub.textContent = LETTERS[k]; bub.setAttribute("aria-hidden", "true");
      const txt = document.createElement("span");
      txt.textContent = opt;
      b.append(bub, txt);
      b.setAttribute("aria-label", `${LETTERS[k]}: ${opt}`);
      b.addEventListener("click", () => answer(k));
      li.append(b);
      list.append(li);
    });
    $("feedback").hidden = true;
    $("next-btn").hidden = true;
    $("next-btn").textContent = state.i === questions.length - 1 ? "See my score" : "Next question";
    startTimer();
    list.querySelector("button")?.focus({ preventScroll: true });
  }

  function startTimer() {
    stopTimer();
    const t = $("timer");
    t.hidden = !state.timerOn;
    if (!state.timerOn) return;
    state.left = SECONDS;
    drawTimer();
    state.timerId = setInterval(() => {
      state.left -= 1;
      drawTimer();
      if (state.left <= 0) answer(-1);
    }, 1000);
  }
  function stopTimer() { clearInterval(state.timerId); state.timerId = null; }
  function drawTimer() {
    $("timer-num").textContent = Math.max(0, state.left);
    $("timer-ring").style.strokeDashoffset = String(94.25 * (1 - state.left / SECONDS));
    $("timer").classList.toggle("low", state.left <= 5);
  }

  function answer(k) {
    if (state.picks[state.i] !== undefined) return;
    stopTimer();
    const q = state.quiz.questions[state.i];
    state.picks[state.i] = k;
    const buttons = [...$("answers").querySelectorAll("button")];
    buttons.forEach((b, idx) => {
      b.disabled = true;
      if (idx === q.answer) b.classList.add("correct");
      if (idx === k && k !== q.answer) b.classList.add("wrong");
    });
    const fb = $("feedback");
    const right = k === q.answer;
    fb.className = `feedback ${right ? "good" : "bad"}`;
    fb.textContent = "";
    const head = document.createElement("strong");
    head.textContent = right ? "Correct!" : k === -1 ? `Time's up. The answer is ${LETTERS[q.answer]}.` : `Not quite. The answer is ${LETTERS[q.answer]}.`;
    const why = document.createElement("span");
    why.textContent = q.explanation;
    fb.append(head, why);
    fb.hidden = false;
    $("bar-fill").style.width = `${((state.i + 1) / state.quiz.questions.length) * 100}%`;
    const next = $("next-btn");
    next.hidden = false;
    next.focus({ preventScroll: true });
  }

  $("next-btn").addEventListener("click", () => {
    if (state.i < state.quiz.questions.length - 1) { state.i += 1; renderQuestion(); }
    else showResults();
  });
  $("quit-btn").addEventListener("click", () => { stopTimer(); showResults(); });

  document.addEventListener("keydown", (e) => {
    if ($("view-quiz").hidden || e.target.tagName === "TEXTAREA") return;
    const map = { "1": 0, "2": 1, "3": 2, "4": 3, a: 0, b: 1, c: 2, d: 3 };
    const k = map[e.key.toLowerCase()];
    if (k !== undefined && state.picks[state.i] === undefined) { e.preventDefault(); answer(k); }
  });

  // ---------- results ----------
  function showResults() {
    stopTimer();
    const qs = state.quiz.questions;
    const done = state.picks.length;
    const total = qs.length;
    let score = 0;
    const missed = [];
    qs.forEach((q, i) => {
      if (state.picks[i] === q.answer) score += 1;
      else missed.push(q);
    });
    $("score-num").textContent = score;
    $("score-total").textContent = total;
    const pct = score / total;
    $("verdict").textContent =
      done < total ? `You answered ${done} of ${total}. Finish the rest next time.` :
      pct === 1 ? "Full marks. You're exam-ready on these notes." :
      pct >= 0.8 ? "Strong. Polish the topics below and you're set." :
      pct >= 0.5 ? "Good start. Revise the topics below, then retake." :
      "These notes need another read. Start with the topics below.";

    const topics = [...new Set(missed.map((q) => q.topic).filter(Boolean))];
    const list = $("revise-list");
    list.textContent = "";
    if (topics.length === 0) {
      const li = document.createElement("li"); li.className = "all-good"; li.textContent = "Nothing to revise — all correct!"; list.append(li);
    } else {
      topics.forEach((t) => { const li = document.createElement("li"); li.textContent = t; list.append(li); });
    }

    const review = $("review-list");
    review.textContent = "";
    missed.forEach((q) => {
      const li = document.createElement("li");
      const qq = document.createElement("div"); qq.textContent = q.question;
      const ra = document.createElement("div"); ra.className = "ra"; ra.textContent = `Answer: ${q.options[q.answer]}`;
      li.append(qq, ra);
      review.append(li);
    });
    $("review-box").hidden = missed.length === 0;
    $("share-status").textContent = "";
    show("results");
  }

  $("retake-btn").addEventListener("click", () => {
    const qs = state.quiz.questions.slice().sort(() => Math.random() - 0.5);
    startQuiz({ ...state.quiz, questions: qs });
  });
  $("new-btn").addEventListener("click", () => show("home"));
  $("share-btn").addEventListener("click", async () => {
    const msg = `I scored ${$("score-num").textContent}/${$("score-total").textContent} on a quiz made from my own notes with Notes2Quiz by P Om Shiva: ${location.origin}`;
    try { await navigator.clipboard.writeText(msg); $("share-status").textContent = "Copied. Paste it anywhere to share."; }
    catch { $("share-status").textContent = msg; }
  });

  updateCount();
})();
