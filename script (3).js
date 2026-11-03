/* ===== Option switching (Chat is the default) ===== */
var tabs  = Array.prototype.slice.call(document.querySelectorAll('.tab'));
var views = {
  chat: document.getElementById('view-chat'),
  id:   document.getElementById('view-id')
};

tabs.forEach(function (tab) {
  tab.addEventListener('click', function () {
    tabs.forEach(function (t) { t.classList.remove('active'); });
    tab.classList.add('active');
    Object.keys(views).forEach(function (key) {
      views[key].classList.remove('active');
    });
    views[tab.dataset.view].classList.add('active');
  });
});

/* ===== Chat ===== */
var messagesEl = document.getElementById('messages');
var chatForm   = document.getElementById('chat-form');
var chatInput  = document.getElementById('chat-input');

/* Storage guard: localStorage grows without bounds otherwise (the original
   kept every message forever until the quota blew up). */
var MAX_MESSAGES = 200;

function loadMessages() {
  try {
    var parsed = JSON.parse(localStorage.getItem('chat_messages'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function saveMessages(list) {
  try {
    localStorage.setItem('chat_messages', JSON.stringify(list.slice(-MAX_MESSAGES)));
  } catch (e) {
    /* quota or privacy mode — the chat still works in memory for this visit */
  }
}

function addBubble(msg) {
  var bubble = document.createElement('div');
  bubble.className = 'bubble ' + (msg.self ? 'self' : 'other');
  bubble.textContent = msg.text;
  messagesEl.appendChild(bubble);
}

function renderMessages() {
  messagesEl.replaceChildren.apply(messagesEl, []);
  var fragment = document.createDocumentFragment();
  loadMessages().forEach(function (msg) {
    var bubble = document.createElement('div');
    bubble.className = 'bubble ' + (msg.self ? 'self' : 'other');
    bubble.textContent = msg.text;
    fragment.appendChild(bubble);
  });
  messagesEl.appendChild(fragment);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

chatForm.addEventListener('submit', function (e) {
  e.preventDefault();
  var text = chatInput.value.trim();
  if (!text) return;

  var list = loadMessages();
  var msg = { text: text, self: true, time: Date.now() };
  list.push(msg);
  saveMessages(list);
  addBubble(msg);
  if (messagesEl.children.length > MAX_MESSAGES) {
    messagesEl.removeChild(messagesEl.firstChild);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;

  chatInput.value = '';
  chatInput.focus();
});

/* ===== ID making (fresh ID every time, old one replaced) ===== */
var idValue   = document.getElementById('current-id');
var makeIdBtn = document.getElementById('make-id');
var lastGeneratedId = null; // kept visible when storage is unavailable

function makeNewId() {
  var bytes = crypto.getRandomValues(new Uint8Array(8));
  var hex = Array.prototype.map.call(bytes, function (b) {
    return b.toString(16).padStart(2, '0');
  }).join('').toUpperCase();
  return hex.slice(0, 4) + '-' + hex.slice(4, 8) + '-' +
         hex.slice(8, 12) + '-' + hex.slice(12, 16);
}

function showCurrentId() {
  idValue.textContent = lastGeneratedId || localStorage.getItem('my_id') || '----';
}

makeIdBtn.addEventListener('click', function () {
  var id = makeNewId();              // generate a brand new ID
  lastGeneratedId = id;
  try {
    localStorage.setItem('my_id', id); // old ID is removed/replaced
  } catch (e) {
    /* storage unavailable — keep the ID visible for this visit */
  }
  showCurrentId();
});

/* ===== Init ===== */
showCurrentId();
renderMessages();
