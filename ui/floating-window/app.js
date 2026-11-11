/* RTA floating window — behavior only; no design values live here. */
(function () {
  "use strict";

  var win = document.getElementById("rtaWindow");
  var messages = win.querySelector('[data-pencil-name="Messages"]');
  var header = win.querySelector('[data-pencil-name="Header"]');
  var collapse = win.querySelector('[data-pencil-name="Collapse"]');
  var pill = document.getElementById("miniPill");
  var pillTime = document.getElementById("miniPillTime");
  var input = document.getElementById("chatInput");
  var send = win.querySelector('[data-pencil-name="Send"]');
  var statusLabel = win.querySelector('[data-pencil-name="Pill Label"]');

  /* ---- session clock ------------------------------------------------- */
  var startedAt = Date.now() - 34 * 1000;
  function fmt(ms) {
    var s = Math.max(0, Math.floor(ms / 1000));
    var m = Math.floor(s / 60);
    return String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }
  function tick() {
    var text = "已启用 " + fmt(Date.now() - startedAt);
    if (statusLabel) statusLabel.textContent = text;
    if (pillTime) pillTime.textContent = fmt(Date.now() - startedAt);
  }
  tick();
  setInterval(tick, 1000);

  /* ---- drag ---------------------------------------------------------- */
  var drag = null;
  header.addEventListener("mousedown", function (e) {
    if (e.target.closest('[data-pencil-name="Collapse"]')) return;
    var rect = win.getBoundingClientRect();
    drag = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    win.classList.add("is-dragging");
    document.body.classList.add("is-dragging");
    e.preventDefault();
  });
  window.addEventListener("mousemove", function (e) {
    if (!drag) return;
    var stage = document.getElementById("stage").getBoundingClientRect();
    var left = Math.min(
      Math.max(0, e.clientX - drag.dx - stage.left),
      stage.width - win.offsetWidth
    );
    var top = Math.min(
      Math.max(0, e.clientY - drag.dy - stage.top),
      stage.height - win.offsetHeight
    );
    win.style.left = left + "px";
    win.style.top = top + "px";
  });
  window.addEventListener("mouseup", function () {
    drag = null;
    win.classList.remove("is-dragging");
    document.body.classList.remove("is-dragging");
  });

  /* ---- collapse / expand --------------------------------------------- */
  function setCollapsed(collapsed) {
    if (collapsed) {
      var rect = win.getBoundingClientRect();
      pill.style.right = (window.innerWidth - rect.right) + "px";
      pill.style.bottom = (window.innerHeight - rect.bottom) + "px";
    }
    document.body.classList.toggle("is-collapsed", collapsed);
  }
  collapse.addEventListener("click", function () {
    setCollapsed(true);
  });
  pill.addEventListener("click", function () {
    setCollapsed(false);
    input.focus();
  });

  /* ---- chat ----------------------------------------------------------- */
  function scrollBottom() {
    messages.scrollTop = messages.scrollHeight;
  }
  scrollBottom();

  function addUserMessage(text) {
    var template = messages.querySelector('[data-pencil-name="User Message"]');
    var node = template.cloneNode(true);
    node.querySelector('[data-pencil-name="Text"]').textContent = text;
    messages.appendChild(node);
    scrollBottom();
    return node;
  }

  function addAiMessage(text) {
    var template = messages.querySelector('[data-pencil-name="AI Message 1"]');
    var node = template.cloneNode(true);
    node.querySelector('[data-pencil-name="Text"]').textContent = text;
    messages.appendChild(node);
    scrollBottom();
    return node;
  }

  function submit() {
    var text = input.value.trim();
    if (!text) return;
    addUserMessage(text);
    input.value = "";
    input.focus();
    var current = text;
    setTimeout(function () {
      addAiMessage("看到了：" + current + "（演示回复）");
    }, 700);
  }

  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  });
  send.addEventListener("click", submit);

  /* The design is a static snapshot; focus the field on load so the window is
   * immediately usable when shown as the real floating panel. */
  window.addEventListener("load", function () {
    input.focus({ preventScroll: true });
    scrollBottom();
  });
})();
