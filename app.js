(() => {
  "use strict";

  const STORAGE_KEY = "nexvo-demo-v1";
  const initialState = {
    profile: null,
    signedOut: false,
    chats: [],
    statuses: [],
    calls: [],
    reports: []
  };
  const statusBackgrounds = {
    mint: "linear-gradient(145deg, #166a55, #153b3c)",
    violet: "linear-gradient(145deg, #6751a3, #322b67)",
    sunset: "linear-gradient(145deg, #bd6447, #702d57)",
    ocean: "linear-gradient(145deg, #287e9b, #203c72)",
    amber: "linear-gradient(145deg, #a87b32, #694435)",
    rose: "linear-gradient(145deg, #a64970, #572f61)"
  };
  const MAX_MEDIA_SIZE = 50 * 1024 * 1024;
  const appVerifiedBadge = '<span class="verified-badge" aria-label="NEXVO موثق" title="NEXVO موثق">✓</span>';
  let databasePromise;
  const mediaUrls = new Map();
  const contacts = [
    { name: "ليان", phone: "+966 55 204 7812" },
    { name: "عمر", phone: "+966 54 319 6620" },
    { name: "نور", phone: "+966 50 478 2156" },
    { name: "سارة", phone: "+966 56 840 1937" },
    { name: "خالد", phone: "+966 53 716 4082" },
    { name: "مها", phone: "+966 59 630 5721" }
  ];
  const $ = (selector, parent = document) => parent.querySelector(selector);
  const $$ = (selector, parent = document) => [...parent.querySelectorAll(selector)];
  const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char]);

  let state = readState();
  let activePage = "chats";
  let activeChatId = null;
  let activeFilter = "all";
  let authMode = "register";
  let currentStatusDraft = null;
  let storyTimer = null;
  let statusExpiryTimer = null;
  let viewedStatusId = null;
  let registerPhotoFile = null;
  let registerPhotoUrl = null;
  let brandConfiguration = { appName: "NEXVO", appVerified: false, showVerifiedBadge: true, assets: {} };

  function readState() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved || typeof saved !== "object") return structuredClone(initialState);
      return {
        ...structuredClone(initialState),
        ...saved,
        profile: saved.profile && typeof saved.profile === "object" ? saved.profile : null,
        chats: Array.isArray(saved.chats) ? saved.chats : [],
        statuses: Array.isArray(saved.statuses) ? saved.statuses : [],
        calls: Array.isArray(saved.calls) ? saved.calls : [],
        reports: Array.isArray(saved.reports) ? saved.reports : []
      };
    } catch (error) {
      console.error("تعذر تحميل بيانات NEXVO المحلية.", error);
      return structuredClone(initialState);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...state, profile: null, signedOut: false }));
    } catch (error) {
      console.error("تعذر حفظ بيانات NEXVO المحلية.", error);
      showToast("تعذر حفظ التغييرات في هذا المتصفح.");
    }
  }

  function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    $("#toast-region").append(toast);
    window.setTimeout(() => toast.remove(), 2800);
  }

  async function apiRequest(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body !== undefined) headers.set("Content-Type", "application/json");
    const response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });
    const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `تعذر إكمال الطلب (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function avatarDataUrl(file, maxDimension = 1024) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      const url = URL.createObjectURL(file);
      image.onload = () => {
        const scale = Math.min(1, maxDimension / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        const context = canvas.getContext("2d");
        if (!context) {
          URL.revokeObjectURL(url);
          reject(new Error("تعذر تجهيز الصورة على هذا الجهاز."));
          return;
        }
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.86));
      };
      image.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("تعذر قراءة الصورة. جرّب PNG أو JPG أو WEBP."));
      };
      image.src = url;
    });
  }

  function applyBrandConfiguration(configuration) {
    brandConfiguration = configuration;
    const name = configuration.appName || "NEXVO";
    document.title = `${name} — تواصل بطريقتك`;
    $$(".brand-wordmark").forEach((element) => {
      element.innerHTML = `${escapeHtml(name)}${configuration.appVerified && configuration.showVerifiedBadge ? appVerifiedBadge : '<span class="brand-dot">.</span>'}`;
    });
    $$(".brand-mark").forEach((element) => {
      const asset = configuration.assets?.logo || configuration.assets?.["app-icon"];
      element.innerHTML = asset ? `<img src="${escapeHtml(asset.path)}" alt="${escapeHtml(name)}">` : "N<span>.</span>";
      element.classList.toggle("brand-mark-image", !!asset);
    });
    const favicon = configuration.assets?.favicon || configuration.assets?.["app-icon"];
    let faviconElement = $("#dynamic-favicon");
    if (favicon) {
      if (!faviconElement) {
        faviconElement = document.createElement("link");
        faviconElement.id = "dynamic-favicon";
        faviconElement.rel = "icon";
        document.head.append(faviconElement);
      }
      faviconElement.href = favicon.path;
    }
  }

  function initials(name) {
    return [...String(name || "?").trim()].slice(0, 1).join("") || "?";
  }

  function displayTime(timestamp) {
    if (!timestamp) return "";
    return new Intl.DateTimeFormat("ar", { hour: "numeric", minute: "2-digit" }).format(new Date(timestamp));
  }

  function openMediaDatabase() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("nexvo-media-v1", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("media");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("تعذر فتح تخزين الوسائط."));
      });
    }
    return databasePromise;
  }

  async function storeMedia(file) {
    const database = await openMediaDatabase();
    const key = crypto.randomUUID();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("media", "readwrite");
      transaction.objectStore("media").put(file, key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("تعذر حفظ الوسيط."));
      transaction.onabort = () => reject(transaction.error || new Error("أُلغي حفظ الوسيط."));
    });
    return key;
  }

  async function mediaUrl(key) {
    if (!key) return null;
    if (mediaUrls.has(key)) return mediaUrls.get(key);
    const database = await openMediaDatabase();
    const file = await new Promise((resolve, reject) => {
      const request = database.transaction("media", "readonly").objectStore("media").get(key);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("تعذر تحميل الوسيط."));
    });
    if (!file) return null;
    const url = URL.createObjectURL(file);
    mediaUrls.set(key, url);
    return url;
  }

  async function hydrateMedia(root = document) {
    const elements = $$("[data-media-key]", root);
    await Promise.all(elements.map(async (element) => {
      try {
        const url = await mediaUrl(element.dataset.mediaKey);
        if (url && element.isConnected) element.src = url;
      } catch (error) {
        console.error("تعذر عرض وسيط NEXVO.", error);
        if (element.isConnected) element.classList.add("media-unavailable");
      }
    }));
  }

  function cleanExpiredStatuses() {
    const expired = state.statuses.filter((status) => Date.now() - status.createdAt >= 24 * 60 * 60 * 1000);
    const current = state.statuses.filter((status) => Date.now() - status.createdAt < 24 * 60 * 60 * 1000);
    if (current.length !== state.statuses.length) {
      state.statuses = current;
      saveState();
      expired.filter((status) => status.mediaKey).forEach((status) => {
        removeMedia(status.mediaKey).catch((error) => {
          console.error("تعذر حذف وسيط الحالة المنتهية من التخزين المحلي.", error);
          showToast("تعذر تنظيف ملف وسائط منتهي الصلاحية.");
        });
      });
    }
  }

  function latestStatus() {
    cleanExpiredStatuses();
    return state.statuses.at(-1) || null;
  }

  function mediaMarkup(item, className) {
    if (!item?.mediaKey) return "";
    const tag = item.mediaType?.startsWith("video/") ? "video" : "img";
    const isPreview = className.includes("story") || className.includes("home-status") || className.includes("status-strip");
    const controls = tag === "video" ? isPreview ? " autoplay muted loop playsinline preload=\"metadata\"" : " autoplay controls playsinline preload=\"metadata\"" : "";
    return `<${tag} class="${className}" data-media-key="${escapeHtml(item.mediaKey)}"${controls} alt="${tag === "img" ? "وسيط الحالة" : ""}"></${tag}>`;
  }

  function avatarMarkup(name, mediaKey, className = "avatar") {
    const photo = state.profile?.avatarUrl === mediaKey && mediaKey
      ? `<img src="${escapeHtml(mediaKey)}" alt="الصورة الشخصية">`
      : mediaKey ? `<img data-media-key="${escapeHtml(mediaKey)}" alt="الصورة الشخصية">` : escapeHtml(initials(name));
    return `<span class="${className}">${photo}</span>`;
  }

  function verificationBadge(level) {
    if (!level || !brandConfiguration.showVerifiedBadge) return "";
    const label = level === "business" ? "حساب أعمال موثق" : level === "official" ? "حساب رسمي موثق" : "حساب موثق";
    return `<span class="verified-badge" title="${label}" aria-label="${label}">✓</span>`;
  }

  function renderStatusStrip() {
    const status = latestStatus();
    const name = state.profile?.name || "NEXVO";
    const photoKey = state.profile?.photoKey;
    const preview = status
      ? `<button class="status-strip-item" data-action="view-status" data-status-id="${escapeHtml(status.id)}">
          <span class="status-strip-avatar">${status.mediaKey
            ? mediaMarkup(status, "status-strip-media")
            : `<span class="status-strip-text" style="background:${statusBackgrounds[status.background] || statusBackgrounds.mint}">${escapeHtml(status.text)}</span>`}</span>
          <span class="status-strip-label">حالتي</span>
        </button>`
      : "";
    $("#status-strip").innerHTML = `<button class="status-strip-item add-status-item" data-action="add-status">
      <span class="status-strip-add">${avatarMarkup(name, photoKey, "avatar")}<span>＋</span></span>
      <span class="status-strip-label">${status ? "إضافة حالة" : "حالتي"}</span>
    </button>${preview}`;
    hydrateMedia($("#status-strip"));
  }

  function renderInbox() {
    const list = $("#conversation-list");
    renderStatusStrip();
    const query = $("#search-input").value.trim().toLocaleLowerCase("ar");
    const chats = state.chats.filter((chat) => {
      const last = chat.messages.at(-1);
      const matchesSearch = `${chat.name} ${chat.phone} ${last?.text || ""}`.toLocaleLowerCase("ar").includes(query);
      const matchesFilter = activeFilter === "all" ||
        (activeFilter === "unread" && chat.unread > 0) ||
        (activeFilter === "favorites" && chat.favorite);
      return matchesSearch && matchesFilter;
    }).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

    if (!chats.length) {
      const isEmpty = state.chats.length === 0;
      list.innerHTML = `<div class="empty-list">
        <div class="empty-list-icon">${isEmpty ? "＋" : "⌕"}</div>
        <strong>${isEmpty ? "لا توجد محادثات بعد" : "لا توجد نتائج"}</strong>
        <span>${isEmpty ? "ابدأ محادثة جديدة مع شخص من جهات اتصالك." : "جرّب تغيير البحث أو عامل التصفية."}</span>
      </div>`;
      return;
    }

    list.innerHTML = chats.map((chat) => {
      const last = chat.messages.at(-1);
      return `<button class="conversation-item ${chat.id === activeChatId ? "selected" : ""}" data-chat-id="${escapeHtml(chat.id)}">
        <span class="avatar">${escapeHtml(initials(chat.name))}</span>
        <span class="conversation-copy">
          <span class="conversation-line"><span class="conversation-name">${escapeHtml(chat.name)}</span><span class="conversation-time">${displayTime(last?.createdAt || chat.updatedAt)}</span></span>
          <span class="conversation-line"><span class="conversation-preview">${escapeHtml(last?.text || "ابدأ المحادثة")}</span>${chat.unread ? `<span class="unread-badge">${chat.unread}</span>` : ""}</span>
        </span>
      </button>`;
    }).join("");
    $$(".conversation-item", list).forEach((item) => item.addEventListener("click", () => openChat(item.dataset.chatId)));
  }

  function renderWelcome() {
    const status = latestStatus();
    const statusStyle = status?.background && statusBackgrounds[status.background] ? `style="background:${statusBackgrounds[status.background]}"` : "";
    const name = state.profile?.name || "NEXVO";
    $("#content-panel").innerHTML = `<div class="welcome-view">
      <button class="home-status-card" data-action="${status ? "view-status" : "add-status"}" ${status ? `data-status-id="${escapeHtml(status.id)}"` : ""}>
        <span class="home-status-avatar">${avatarMarkup(name, state.profile?.photoKey, "avatar")}</span>
        <span class="home-status-copy"><strong>${status ? "حالتك الأخيرة" : "أضف حالة جديدة"}</strong><span>${status ? escapeHtml(status.text || (status.mediaType?.startsWith("video/") ? "مقطع فيديو" : status.mediaKey ? "صورة" : "حالة نصية")) : "شارك صورة أو فيديو أو عبارة"}</span></span>
        ${status?.mediaKey ? mediaMarkup(status, "home-status-media") : `<span class="home-status-text-preview" ${statusStyle}>${status ? escapeHtml(status.text || "حالة جديدة") : "＋"}</span>`}
      </button>
      <div class="welcome-orb"><div class="orb-glyph">N</div></div>
      <h2>كل تواصل يبدأ بلحظة</h2>
      <p>مساحة هادئة لتبقى قريبًا من الأشخاص المهمين. ابدأ محادثة، شارك حالة، أو استكشف NEXVO.</p>
      <div class="welcome-cta">
        <button class="primary-button" data-action="new-chat">＋ &nbsp; محادثة جديدة</button>
        <button class="secondary-button" data-page="updates">استكشف الحالات</button>
      </div>
      <div class="privacy-note"><span>⌑</span> محادثاتك خاصة، وبياناتك محفوظة على هذا الجهاز</div>
    </div>`;
    hydrateMedia($("#content-panel"));
  }

  function openChat(id) {
    const chat = state.chats.find((item) => item.id === id);
    if (!chat) return;
    activeChatId = id;
    chat.unread = 0;
    saveState();
    renderInbox();
    document.body.classList.add("mobile-page");
    renderChat(chat);
  }

  function renderChat(chat) {
    const messageContent = chat.messages.length
      ? chat.messages.map((message) => `<div class="message-bubble ${message.mine ? "mine" : ""}">${escapeHtml(message.text)}<span class="message-time">${displayTime(message.createdAt)}</span></div>`).join("")
      : `<div class="chat-empty">هذه بداية محادثتك مع ${escapeHtml(chat.name)}. أرسل رسالة لتبدأوا الحديث. تذكّر: هذا نموذج محلي تجريبي وليس خدمة إرسال حقيقية.</div>`;

    $("#content-panel").innerHTML = `<section class="chat-view">
      <header class="chat-header">
        <button class="icon-button mobile-back" data-action="back" aria-label="العودة">‹</button>
        <span class="avatar">${escapeHtml(initials(chat.name))}</span>
        <div class="chat-head-copy"><strong>${escapeHtml(chat.name)}</strong><span>محادثة تجريبية · خاصة</span></div>
        <div class="chat-actions">
          <button class="icon-button" data-action="toggle-favorite" aria-label="${chat.favorite ? "إزالة من المفضلة" : "إضافة إلى المفضلة"}" title="${chat.favorite ? "إزالة من المفضلة" : "إضافة إلى المفضلة"}"><svg viewBox="0 0 24 24" aria-hidden="true" ${chat.favorite ? `style="fill:var(--accent);stroke:var(--accent)"` : ""}><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg></button>
          <button class="icon-button" data-action="audio-call" aria-label="مكالمة صوتية" title="مكالمة تجريبية"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.8 9.7 7l-2 2.5a14 14 0 0 0 6.8 6.8l2.5-2 3.2 3.1-1.5 3a2 2 0 0 1-2.2 1.1A18.6 18.6 0 0 1 2.5 7.5 2 2 0 0 1 3.6 5.3l3-1.5Z"/></svg></button>
          <button class="icon-button" data-action="video-call" aria-label="مكالمة فيديو" title="مكالمة فيديو تجريبية"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/></svg></button>
          <button class="icon-button" data-action="report-chat" aria-label="إبلاغ" title="الإبلاغ عن مستخدم"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 21V4m0 1c5-4 9 3 14-1v11c-5 4-9-3-14 1"/></svg></button>
        </div>
      </header>
      <div class="chat-history" id="chat-history">${messageContent}</div>
      <form class="composer" id="message-form">
        <textarea id="message-input" rows="1" maxlength="2000" placeholder="اكتب رسالة..." aria-label="اكتب رسالة"></textarea>
        <button class="send-button" type="submit" aria-label="إرسال">➤</button>
      </form>
    </section>`;
    $("#message-form").addEventListener("submit", (event) => sendMessage(event, chat));
    $("#message-input").addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        $("#message-form").requestSubmit();
      }
    });
  }

  function sendMessage(event, chat) {
    event.preventDefault();
    const input = $("#message-input");
    const text = input.value.trim();
    if (!text) return;
    chat.messages.push({ id: crypto.randomUUID(), text, mine: true, createdAt: Date.now() });
    chat.updatedAt = Date.now();
    saveState();
    renderInbox();
    renderChat(chat);
    $("#chat-history").scrollTop = $("#chat-history").scrollHeight;
    $("#message-input").focus();
  }

  function renderUpdates() {
    cleanExpiredStatuses();
    const ownStatus = latestStatus();
    const statusCards = state.statuses.slice().reverse().map((status) => `<button class="status-story-card" data-action="view-status" data-status-id="${escapeHtml(status.id)}" ${status.background && statusBackgrounds[status.background] ? `style="--story-background:${statusBackgrounds[status.background]}"` : ""}>
      ${mediaMarkup(status, "status-story-media")}
      ${status.text ? `<span class="status-story-caption">${escapeHtml(status.text)}</span>` : ""}
      <span class="status-story-owner">${avatarMarkup(state.profile.name, state.profile.photoKey, "avatar status-story-avatar")}<span><strong>${escapeHtml(state.profile.name)}</strong><small>${displayTime(status.createdAt)}</small></span></span>
    </button>`).join("");
    $("#content-panel").innerHTML = `<section class="page-view">
      <div class="page-topline"><span class="eyebrow">لحظات تختفي بعد 24 ساعة</span><button class="primary-button" data-action="add-status">＋ حالة جديدة</button></div>
      <h2>الحالات</h2><p class="page-description">شارك صورة أو فكرة قصيرة مع جهات اتصالك. أنت من يختار ما تشاركه.</p>
      <h3 class="section-label">حالتي</h3>
      <button class="my-status-card" data-action="${ownStatus ? "view-status" : "add-status"}" ${ownStatus ? `data-status-id="${escapeHtml(ownStatus.id)}"` : ""}>
        <span class="my-status-ring">${ownStatus?.mediaKey ? mediaMarkup(ownStatus, "my-status-thumb") : avatarMarkup(state.profile.name, state.profile.photoKey, "avatar update-ring")}</span>
        <span class="update-card-copy"><strong>${ownStatus ? "حالتي" : "أضف حالتك الأولى"}</strong><span>${ownStatus ? escapeHtml(ownStatus.text || (ownStatus.mediaType?.startsWith("video/") ? "مقطع فيديو" : ownStatus.mediaKey ? "صورة" : "حالة نصية")) + " · " + displayTime(ownStatus.createdAt) : "شارك صورة أو فيديو أو عبارة."}</span></span>
        ${ownStatus ? `<span class="status-add-badge" aria-hidden="true">›</span>` : `<span class="status-add-badge" aria-hidden="true">＋</span>`}
      </button>
      ${statusCards ? `<h3 class="section-label">تحديثاتك</h3><div class="status-story-grid">${statusCards}</div>` : ""}
      <div class="info-banner"><span class="info-icon">⌑</span><span>حالاتك محفوظة على هذا الجهاز فقط. تبقى ظاهرة لمدة 24 ساعة، ولا يراها مستخدمون آخرون في النموذج التجريبي.</span></div>
    </section>`;
    hydrateMedia($("#content-panel"));
  }

  function renderCalls() {
    const calls = state.calls.slice().reverse();
    $("#content-panel").innerHTML = `<section class="page-view">
      <span class="eyebrow">تواصل بصوتك أو صورتك</span><h2>المكالمات</h2>
      <p class="page-description">ابدأ مكالمة تجريبية من محادثة. الاتصال الصوتي والمرئي الحقيقي يحتاج إلى خادم وإعداد WebRTC وموافقة الطرفين.</p>
      <div class="info-banner"><span class="info-icon">◉</span><span>لا يتم تشغيل الكاميرا أو الميكروفون في هذا النموذج، ولا توجد مشاهدة أو تسجيل للمكالمات.</span></div>
      <h3 class="section-label">الأخيرة</h3>
      ${calls.length ? calls.map((call) => `<div class="call-card"><div class="call-symbol">${call.type === "فيديو" ? "▣" : "⌁"}</div><div class="call-card-copy"><strong>${escapeHtml(call.name)}</strong><span>${escapeHtml(call.type)} · ${displayTime(call.createdAt)} · ${escapeHtml(call.status)}</span></div><button class="icon-button" data-action="repeat-call" data-chat-id="${escapeHtml(call.chatId)}" aria-label="إعادة الاتصال">↗</button></div>`).join("") : `<div class="empty-list"><div class="empty-list-icon">⌁</div><strong>لا توجد مكالمات</strong><span>ستظهر المكالمات التجريبية التي تبدأها من داخل المحادثة هنا.</span></div>`}
    </section>`;
  }

  function renderProfile() {
    $("#content-panel").innerHTML = `<section class="page-view">
      <span class="eyebrow">مساحتك الخاصة</span><h2>الملف الشخصي</h2>
      <p class="page-description">تحكم ببيانات ملفك على هذا الجهاز.</p>
      <div class="profile-card"><button class="profile-photo-button" data-action="pick-profile-photo" aria-label="تغيير الصورة الشخصية">${avatarMarkup(state.profile.name, state.profile.avatarUrl || state.profile.photoKey, "avatar profile-photo")}</button><div class="profile-details"><strong>${escapeHtml(state.profile.name)} ${verificationBadge(state.profile.verificationLevel)}</strong><span dir="ltr">${escapeHtml(state.profile.phone)}</span>${state.profile.username ? `<span dir="ltr">@${escapeHtml(state.profile.username)}</span>` : ""}<button class="text-button" data-action="pick-profile-photo">تغيير الصورة الشخصية</button><input id="profile-photo-input" class="visually-hidden" type="file" accept="image/*" aria-label="اختر صورة شخصية" hidden></div><button class="secondary-button" data-action="edit-profile">تعديل</button></div>
      <div class="profile-status-panel"><div><h3 class="section-label">حالتك</h3><p>${latestStatus() ? "آخر حالة تظهر في الصفحة الرئيسية وتختفي بعد 24 ساعة." : "شارك صورة أو فيديو أو حالة نصية تظهر في واجهة التطبيق."}</p></div><button class="primary-button" data-action="add-status">＋ إضافة حالة</button></div>
      ${state.statuses.length ? `<div class="status-story-grid profile-story-grid">${state.statuses.slice().reverse().map((status) => `<button class="status-story-card" data-action="view-status" data-status-id="${escapeHtml(status.id)}" ${status.background && statusBackgrounds[status.background] ? `style="--story-background:${statusBackgrounds[status.background]}"` : ""}>${mediaMarkup(status, "status-story-media")}${status.text ? `<span class="status-story-caption">${escapeHtml(status.text)}</span>` : ""}<span class="status-story-owner"><span class="avatar status-story-avatar">${escapeHtml(initials(state.profile.name))}</span><span><strong>حالتي</strong><small>${displayTime(status.createdAt)}</small></span></span></button>`).join("")}</div>` : ""}
      <h3 class="section-label">الإعدادات</h3>
      <div class="settings-list">
        <button class="setting-row" data-action="privacy-info"><span>الخصوصية والأمان</span><span>›</span></button>
        <button class="setting-row" data-action="storage-info"><span>البيانات والتخزين</span><span>محلي</span></button>
        <button class="setting-row" data-action="admin-login"><span>دخول المشرف</span><span>مقيّد بتسجيل آمن</span></button>
        <button class="setting-row" data-action="clear-data"><span>مسح بيانات هذا الجهاز</span><span>›</span></button>
        <button class="setting-row" data-action="logout"><span>تسجيل الخروج</span><span>›</span></button>
      </div>
      <div class="privacy-note"><span>⌑</span> تُحفظ بيانات حسابك على خادم NEXVO؛ المحادثات التجريبية محلية</div>
    </section>`;
    hydrateMedia($("#content-panel"));
  }

  async function renderAdminDashboard(page = 1) {
    activePage = "admin";
    document.body.classList.add("mobile-page");
    $("#inbox-kicker").textContent = `${brandConfiguration.appName} · إدارة آمنة`;
    $("#inbox-title").textContent = "لوحة التحكم";
    $("#conversation-list").innerHTML = "";
    $("#content-panel").innerHTML = `<section class="page-view"><div class="loading-skeleton"></div><div class="loading-skeleton"></div><div class="loading-skeleton"></div></section>`;
    try {
      const params = new URLSearchParams(location.search);
      params.set("page", String(page));
      params.set("perPage", "10");
      params.set("search", params.get("userSearch") || "");
      params.set("filter", params.get("filter") || "all");
      const [overview, userPage, brand] = await Promise.all([
        apiRequest("/api/admin/overview"),
        apiRequest(`/api/admin/users?${params}`),
        apiRequest("/api/brand")
      ]);
      applyBrandConfiguration(brand);
      $("#content-panel").innerHTML = `<section class="page-view admin-view">
        <div class="page-topline"><span class="eyebrow">إدارة NEXVO · حساب موثّق الصلاحية</span><button class="secondary-button" data-action="admin-logout">تسجيل خروج المشرف</button></div>
        <h2>لوحة التحكم</h2><p class="page-description">ملخص مباشر لحسابات المستخدمين وإعدادات هوية التطبيق.</p>
        <div class="admin-stats">
          ${[["المستخدمون", overview.totalUsers], ["نشطون خلال 24 ساعة", overview.activeUsers], ["موثّقون", overview.verifiedUsers], ["موقوفون", overview.suspendedUsers], ["محظورون", overview.bannedUsers]].map(([label, value]) => `<div class="admin-stat"><span>${label}</span><strong>${value}</strong></div>`).join("")}
        </div>
        <div class="admin-section-heading"><div><h3>المستخدمون</h3><p>إدارة التوثيق وحالة الحساب وتصفية النتائج.</p></div><input class="admin-search" id="admin-user-search" type="search" value="${escapeHtml(new URLSearchParams(location.search).get("userSearch") || "")}" placeholder="ابحث بالاسم أو الهاتف أو username"></div>
        <div class="admin-filter-row">
          ${[["all","الكل"],["verified","موثقون"],["unverified","غير موثقين"],["suspended","موقوفون"],["banned","محظورون"]].map(([value,label]) => `<button class="filter-chip ${new URLSearchParams(location.search).get("filter") === value || (!new URLSearchParams(location.search).has("filter") && value === "all") ? "selected" : ""}" data-action="admin-filter" data-filter="${value}">${label}</button>`).join("")}
        </div>
        <div class="admin-user-list">${userPage.users.length ? userPage.users.map((member) => `<article class="admin-user-row" data-user-id="${escapeHtml(member.id)}" data-account-status="${escapeHtml(member.accountStatus)}" data-verification-level="${escapeHtml(member.verificationLevel || "")}">
          ${avatarMarkup(member.name, member.avatarUrl, "avatar admin-user-avatar")}
          <div class="admin-user-details"><strong>${escapeHtml(member.name)} ${verificationBadge(member.verificationLevel)}</strong><span>${escapeHtml(member.username ? "@" + member.username : member.phone || member.email || "—")}</span><small>انضم ${new Intl.DateTimeFormat("ar", { dateStyle: "medium" }).format(new Date(member.createdAt))} · آخر نشاط ${new Intl.DateTimeFormat("ar", { dateStyle: "short", timeStyle: "short" }).format(new Date(member.lastActive))}</small></div>
          <div class="admin-user-controls">
            <select data-admin-field="verificationLevel" aria-label="مستوى توثيق الحساب">
              <option value="" ${!member.verificationLevel ? "selected" : ""}>غير موثق</option>
              <option value="verified" ${member.verificationLevel === "verified" ? "selected" : ""}>Verified</option>
              <option value="business" ${member.verificationLevel === "business" ? "selected" : ""}>Business</option>
              <option value="official" ${member.verificationLevel === "official" ? "selected" : ""}>Official</option>
            </select>
            <select data-admin-field="accountStatus" aria-label="حالة الحساب">
              <option value="active" ${member.accountStatus === "active" ? "selected" : ""}>نشط</option>
              <option value="suspended" ${member.accountStatus === "suspended" ? "selected" : ""}>موقوف</option>
              <option value="banned" ${member.accountStatus === "banned" ? "selected" : ""}>محظور</option>
            </select>
            <button class="secondary-button" data-action="save-user-admin" data-user-id="${escapeHtml(member.id)}">حفظ</button>
          </div>
        </article>`).join("") : `<div class="empty-list"><strong>لا توجد حسابات مطابقة</strong><span>سيظهر المستخدمون بعد إنشاء حساباتهم.</span></div>`}</div>
        <div class="admin-pagination"><span>${userPage.total} مستخدم · صفحة ${userPage.page} من ${Math.max(1, Math.ceil(userPage.total / userPage.perPage))}</span><div><button class="secondary-button" data-action="admin-page" data-page="${Math.max(1, page - 1)}" ${page <= 1 ? "disabled" : ""}>السابق</button><button class="secondary-button" data-action="admin-page" data-page="${page + 1}" ${page * userPage.perPage >= userPage.total ? "disabled" : ""}>التالي</button></div></div>
        <h3 class="section-label">Brand Studio</h3><p class="page-description">غيّر هوية NEXVO واعرض معاينة قبل حفظ إعدادات الخادم.</p>
        <div class="brand-studio-panel">
          <form id="brand-settings-form">
            <label class="form-field"><span>اسم التطبيق</span><input name="appName" maxlength="40" value="${escapeHtml(brand.appName)}" required></label>
            <label class="admin-toggle-row"><span><strong>علامة توثيق التطبيق</strong><small>إظهار الشارة بجانب اسم التطبيق</small></span><input type="checkbox" name="appVerified" ${brand.appVerified ? "checked" : ""}></label>
            <label class="admin-toggle-row"><span><strong>إظهار علامات توثيق المستخدمين</strong><small>تشغيل أو إخفاء شارات المستخدمين الموثقين</small></span><input type="checkbox" name="showVerifiedBadge" ${brand.showVerifiedBadge ? "checked" : ""}></label>
            <div class="brand-asset-grid">${[
              ["logo","الشعار الرئيسي","image/png,image/jpeg,image/webp,image/svg+xml"],
              ["app-icon","أيقونة التطبيق","image/png,image/jpeg,image/webp,image/svg+xml"],
              ["favicon","Favicon / ICO","image/png,image/jpeg,image/webp,image/svg+xml,image/x-icon"],
              ["default-avatar","الصورة الافتراضية","image/png,image/jpeg,image/webp"],
              ["open-graph","صورة Open Graph","image/png,image/jpeg,image/webp"]
            ].map(([slot,label,accept]) => {
              const asset = brand.assets?.[slot];
              return `<label class="brand-asset-card"><span>${label}</span><div class="brand-asset-preview" id="preview-${slot}">${asset ? `<img src="${escapeHtml(asset.path)}" alt="${label}">` : `<span>معاينة</span>`}</div><input type="file" data-brand-slot="${slot}" accept="${accept}"><small>PNG · JPG · WEBP${slot !== "default-avatar" && slot !== "open-graph" ? " · SVG · ICO" : ""}</small></label>`;
            }).join("")}</div>
            <div class="modal-actions"><button class="primary-button" type="submit">حفظ إعدادات الهوية</button></div>
          </form>
          <div class="brand-live-preview"><span class="eyebrow">معاينة مباشرة</span><strong id="brand-preview-name">${escapeHtml(brand.appName)} ${brand.appVerified && brand.showVerifiedBadge ? appVerifiedBadge : ""}</strong><small>ستظهر الهوية الجديدة في التطبيق بعد الحفظ.</small></div>
        </div>
        <h3 class="section-label">سجل الإدارة</h3>
        <div class="admin-activity-list">${overview.recentActivity.map((entry) => `<div class="admin-activity-row"><span>${escapeHtml(entry.action)}</span><time>${new Intl.DateTimeFormat("ar", { dateStyle: "short", timeStyle: "short" }).format(new Date(entry.createdAt))}</time></div>`).join("") || `<p class="modal-copy">لا توجد أحداث مسجلة بعد.</p>`}</div>
      </section>`;
      hydrateMedia($("#content-panel"));
      bindAdminDashboard(userPage.page, brand);
    } catch (error) {
      $("#content-panel").innerHTML = `<section class="page-view"><div class="info-banner"><span class="info-icon">!</span><span>${escapeHtml(error.message)} <button class="text-button" data-action="admin-login">تسجيل الدخول مجددًا</button></span></div></section>`;
    }
  }

  function bindAdminDashboard(page, brand) {
    const form = $("#brand-settings-form");
    form.addEventListener("input", () => {
      const name = form.elements.appName.value.trim() || brand.appName;
      const verified = form.elements.appVerified.checked && form.elements.showVerifiedBadge.checked;
      $("#brand-preview-name").innerHTML = `${escapeHtml(name)} ${verified ? appVerifiedBadge : ""}`;
    });
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const settings = {
        appName: form.elements.appName.value.trim(),
        appVerified: form.elements.appVerified.checked,
        showVerifiedBadge: form.elements.showVerifiedBadge.checked
      };
      try {
        const updated = await apiRequest("/api/admin/brand", { method: "PATCH", body: settings });
        applyBrandConfiguration(updated);
        showToast("حُفظت إعدادات الهوية.");
      } catch (error) {
        showToast(error.message);
      }
    });
    $$("[data-brand-slot]", form).forEach((input) => input.addEventListener("change", async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (file.size > 8 * 1024 * 1024) {
        showToast("حجم الشعار يجب ألا يتجاوز 8 ميغابايت.");
        input.value = "";
        return;
      }
      const preview = $(`#preview-${input.dataset.brandSlot}`);
      const previewUrl = URL.createObjectURL(file);
      preview.innerHTML = `<img src="${previewUrl}" alt="معاينة ${escapeHtml(input.dataset.brandSlot)}">`;
      try {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result);
          reader.onerror = () => reject(new Error("تعذرت قراءة ملف الهوية."));
          reader.readAsDataURL(file);
        });
        const updated = await apiRequest(`/api/admin/brand/assets/${input.dataset.brandSlot}`, { method: "POST", body: { dataUrl } });
        applyBrandConfiguration(updated);
        URL.revokeObjectURL(previewUrl);
        preview.innerHTML = `<img src="${escapeHtml(updated.assets[input.dataset.brandSlot].path)}" alt="معاينة محفوظة">`;
        showToast("تم حفظ أصل الهوية في الخادم.");
      } catch (error) {
        URL.revokeObjectURL(previewUrl);
        showToast(error.message);
      }
    }));
    $("#admin-user-search").addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        const params = new URLSearchParams(location.search);
        params.set("userSearch", $("#admin-user-search").value.trim());
        history.replaceState(null, "", `${location.pathname}?${params}`);
        renderAdminDashboard(1);
      }
    });
    $$("[data-action='admin-filter']").forEach((button) => button.addEventListener("click", () => {
      const params = new URLSearchParams(location.search);
      params.set("filter", button.dataset.filter);
      params.set("userSearch", $("#admin-user-search").value.trim());
      history.replaceState(null, "", `${location.pathname}?${params}`);
      renderAdminDashboard(1);
    }));
    $$("[data-action='admin-page']").forEach((button) => button.addEventListener("click", () => {
      const params = new URLSearchParams(location.search);
      params.set("userSearch", $("#admin-user-search").value.trim());
      history.replaceState(null, "", `${location.pathname}?${params}`);
      renderAdminDashboard(Number(button.dataset.page));
    }));
    $$(".admin-user-controls button[data-action='save-user-admin']").forEach((button) => button.addEventListener("click", async () => {
      const row = button.closest("[data-user-id]");
      const verificationLevel = $("[data-admin-field='verificationLevel']", row).value || null;
      const accountStatus = $("[data-admin-field='accountStatus']", row).value;
      if ((accountStatus !== row.dataset.accountStatus && accountStatus !== "active") ||
          (verificationLevel !== (row.dataset.verificationLevel || null) && !verificationLevel)) {
        const confirmed = await confirmAdminChange(accountStatus !== "active" ? `تغيير حالة الحساب إلى ${accountStatus === "banned" ? "محظور" : "موقوف"}؟` : "إلغاء توثيق هذا الحساب؟");
        if (!confirmed) return;
      }
      try {
        await apiRequest(`/api/admin/users/${button.dataset.userId}`, { method: "PATCH", body: { verificationLevel, accountStatus } });
        showToast("تم تحديث حساب المستخدم.");
        renderAdminDashboard(page);
      } catch (error) {
        showToast(error.message);
      }
    }));
  }

  function confirmAdminChange(message) {
    return new Promise((resolve) => {
      openModal(`<div class="modal-header"><h2 id="modal-title">تأكيد إجراء إداري</h2><button class="modal-close" data-action="close-modal" aria-label="إلغاء">×</button></div><p class="modal-copy">${escapeHtml(message)}</p><div class="modal-actions"><button class="secondary-button" data-action="admin-cancel">إلغاء</button><button class="danger-button" data-action="admin-confirm">تأكيد</button></div>`);
      const finish = (value) => {
        closeModal();
        resolve(value);
      };
      $("[data-action='admin-cancel']").addEventListener("click", () => finish(false));
      $("[data-action='admin-confirm']").addEventListener("click", () => finish(true));
    });
  }

  function renderPage() {
    document.body.classList.remove("admin-page");
    $$(".rail-link[data-page]").forEach((button) => button.classList.toggle("active", button.dataset.page === activePage));
    $("#inbox-kicker").textContent = activePage === "chats" ? "مساحتك، على طريقتك" : "NEXVO · مساحتك الخاصة";
    $("#inbox-title").textContent = ({ chats: "المحادثات", updates: "الحالات", calls: "المكالمات", profile: "الملف الشخصي" })[activePage];
    if (activePage === "chats") {
      if (activeChatId && state.chats.some((chat) => chat.id === activeChatId)) renderChat(state.chats.find((chat) => chat.id === activeChatId));
      else renderWelcome();
    }
    if (activePage === "updates") renderUpdates();
    if (activePage === "calls") renderCalls();
    if (activePage === "profile") renderProfile();
    if (activePage === "admin") void renderAdminDashboard();
    renderInbox();
  }

  function renderAuth() {
    $("#auth-overlay")?.remove();
    const registration = authMode === "register";
    const adminLogin = authMode === "admin";
    const root = document.createElement("div");
    root.className = "auth-overlay";
    root.id = "auth-overlay";
    root.innerHTML = `<section class="auth-card">
      <div class="auth-brand"><span class="brand-mark">N</span><strong>NEXVO</strong></div>
      <h1>${registration ? "أهلًا بك في NEXVO" : adminLogin ? "دخول المشرف" : "مرحبًا بعودتك"}</h1>
      <p>${registration ? "أنشئ حسابك بصورة شخصية واسم مستخدم، لتبدأ مساحة تواصل جديدة." : adminLogin ? "تسجيل المشرف محمي بالخادم. لا توجد بيانات دخول مضمنة في الصفحة." : "أدخل رقم هاتفك وكلمة المرور للمتابعة."}</p>
      <form id="auth-form">
        ${registration ? `<label class="form-field"><span>الاسم</span><input name="name" type="text" maxlength="48" placeholder="كيف نناديك؟" autocomplete="name" required></label>
        <label class="form-field"><span>اسم المستخدم (اختياري)</span><input name="username" type="text" maxlength="24" placeholder="@username" autocomplete="username" dir="ltr"></label>
        <label class="form-field"><span>الصورة الشخصية (اختيارية)</span><input id="register-photo-input" name="avatar" type="file" accept="image/png,image/jpeg,image/webp" aria-label="اختر صورة شخصية"><span id="register-photo-preview" class="register-photo-preview">معاينة الصورة الشخصية</span></label>
        <label class="form-field"><span>رقم الهاتف</span><input name="phone" type="tel" maxlength="24" placeholder="+966 5X XXX XXXX" autocomplete="tel" dir="ltr" required></label>` : `<label class="form-field"><span>${adminLogin ? "البريد الإلكتروني" : "رقم الهاتف"}</span><input name="identifier" type="${adminLogin ? "email" : "tel"}" maxlength="254" placeholder="${adminLogin ? "admin@example.com" : "+966 5X XXX XXXX"}" autocomplete="${adminLogin ? "username" : "tel"}" dir="ltr" required></label>`}
        <label class="form-field"><span>كلمة المرور</span><input name="password" type="password" minlength="${registration ? 12 : 1}" maxlength="256" autocomplete="${registration ? "new-password" : "current-password"}" required></label>
        <button class="primary-button auth-submit" type="submit">${registration ? "إنشاء الحساب" : adminLogin ? "دخول لوحة التحكم" : "تسجيل الدخول"}</button>
      </form>
      ${!adminLogin ? `<button class="auth-toggle" id="auth-toggle">${registration ? "لديك حساب؟ تسجيل الدخول" : "مستخدم جديد؟ إنشاء حساب"}</button>` : ""}
      ${adminLogin ? `<button class="auth-toggle" data-action="cancel-admin-login">عودة إلى التطبيق</button>` : `<button class="auth-toggle" data-action="admin-login">دخول المشرف</button>`}
      <small class="auth-footnote">${registration ? "تُخزّن كلمة المرور بعد تجزئتها على الخادم. استخدم كلمة مرور فريدة." : "اتصال آمن بخادم NEXVO؛ لا تُحفظ كلمة المرور في المتصفح."}</small>
    </section>`;
    document.body.append(root);
    if (!adminLogin) {
      $("#auth-toggle").addEventListener("click", () => {
        authMode = registration ? "login" : "register";
        renderAuth();
      });
    }
    $("#register-photo-input")?.addEventListener("change", () => {
      const file = $("#register-photo-input").files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/") || file.size > MAX_MEDIA_SIZE) {
        showToast("اختر صورة صالحة لا يتجاوز حجمها 50 ميغابايت.");
        $("#register-photo-input").value = "";
        return;
      }
      registerPhotoFile = file;
      if (registerPhotoUrl) URL.revokeObjectURL(registerPhotoUrl);
      registerPhotoUrl = URL.createObjectURL(file);
      $("#register-photo-preview").innerHTML = `<img src="${registerPhotoUrl}" alt="معاينة الصورة الشخصية"><span>${escapeHtml(file.name)}</span>`;
    });
    $("#auth-form").addEventListener("submit", (event) => {
      event.preventDefault();
      void (async () => {
        const form = new FormData(event.currentTarget);
        const password = String(form.get("password") || "");
        try {
          let result;
          if (registration) {
            const phone = String(form.get("phone") || "").trim();
            if (phone.replace(/\D/g, "").length < 7) throw new Error("أدخل رقم هاتف صحيحًا.");
            const avatarData = registerPhotoFile ? await avatarDataUrl(registerPhotoFile) : undefined;
            result = await apiRequest("/api/auth/register", {
              method: "POST",
              body: { name: form.get("name"), username: form.get("username"), phone, password, avatarData }
            });
          } else {
            result = await apiRequest("/api/auth/login", {
              method: "POST",
              body: { identifier: form.get("identifier"), password }
            });
          }
          if (adminLogin && !["super_admin", "admin"].includes(result.user.role)) {
            await apiRequest("/api/auth/logout", { method: "POST", body: {} });
            throw new Error("هذا الحساب لا يملك صلاحية المشرف.");
          }
          state.profile = result.user;
          state.signedOut = false;
          saveState();
          if (registerPhotoUrl) URL.revokeObjectURL(registerPhotoUrl);
          registerPhotoUrl = null;
          registerPhotoFile = null;
          root.remove();
          syncProfileAvatar();
          if (adminLogin) {
            await renderAdminDashboard();
          } else {
            activePage = "chats";
            renderPage();
          }
        } catch (error) {
          showToast(error.message || "تعذر الاتصال بالخادم.");
        }
      })();
    });
  }

  function syncProfileAvatar() {
    $("#rail-avatar").innerHTML = state.profile
      ? state.profile.avatarUrl ? `<img src="${escapeHtml(state.profile.avatarUrl)}" alt="الصورة الشخصية">` : state.profile.photoKey ? `<img data-media-key="${escapeHtml(state.profile.photoKey)}" alt="الصورة الشخصية">` : escapeHtml(initials(state.profile.name))
      : "N";
    hydrateMedia($("#rail-avatar"));
  }

  function openModal(content) {
    $("#modal-card").innerHTML = content;
    $("#modal-backdrop").classList.remove("hidden");
    $("#modal-card").focus();
  }

  function closeModal() {
    $("#modal-backdrop").classList.add("hidden");
    if (currentStatusDraft?.previewUrl) URL.revokeObjectURL(currentStatusDraft.previewUrl);
    currentStatusDraft = null;
  }

  function openNewChat() {
    const options = contacts.map((contact, index) => `<button class="contact-option" data-contact-index="${index}">
      <span class="avatar">${escapeHtml(initials(contact.name))}</span><span><strong>${escapeHtml(contact.name)}</strong><small dir="ltr">${escapeHtml(contact.phone)}</small></span>
    </button>`).join("");
    openModal(`<div class="modal-header"><h2 id="modal-title">محادثة جديدة</h2><button class="modal-close" data-action="close-modal" aria-label="إغلاق">×</button></div>
      <p class="modal-copy">اختر جهة اتصال لبدء محادثة تجريبية. لن يتم إرسال دعوة أو رسالة فعلية.</p>
      <div class="contact-tools"><button class="primary-button" data-action="pick-contacts">⌕ اختيار من الهاتف</button><button class="secondary-button" data-action="manual-contact">＋ إدخال رقم</button></div>
      <div class="contact-list">${options}</div>`);
    $$(".contact-option").forEach((button) => button.addEventListener("click", () => {
      const contact = contacts[Number(button.dataset.contactIndex)];
      createChat(contact.name, contact.phone);
    }));
  }

  function createChat(name, phone) {
    let chat = state.chats.find((item) => item.phone.replace(/\D/g, "") === phone.replace(/\D/g, ""));
    if (!chat) {
      chat = { id: crypto.randomUUID(), name, phone, messages: [], unread: 0, favorite: false, updatedAt: Date.now() };
      state.chats.push(chat);
      saveState();
    }
    closeModal();
    activePage = "chats";
    openChat(chat.id);
  }

  async function pickContacts() {
    if (!("contacts" in navigator) || !navigator.contacts?.select) {
      showToast("اختيار جهات الاتصال غير مدعوم في هذا المتصفح. استخدم الإدخال اليدوي.");
      return;
    }
    try {
      const selected = await navigator.contacts.select(["name", "tel"], { multiple: false });
      const person = selected[0];
      if (person?.name?.[0] && person?.tel?.[0]) createChat(person.name[0], person.tel[0]);
    } catch (error) {
      if (error.name !== "AbortError") {
        console.error("تعذر فتح منتقي جهات الاتصال.", error);
        showToast("تعذر الوصول إلى جهات الاتصال.");
      }
    }
  }

  function openManualContact() {
    openModal(`<div class="modal-header"><h2 id="modal-title">إضافة جهة اتصال</h2><button class="modal-close" data-action="close-modal" aria-label="إغلاق">×</button></div>
      <p class="modal-copy">أدخل الاسم ورقم الهاتف يدويًا. لن تُرفع هذه المعلومات إلى أي خادم.</p>
      <form id="contact-form"><label class="form-field"><span>الاسم</span><input name="name" maxlength="48" required></label>
      <label class="form-field"><span>رقم الهاتف</span><input name="phone" type="tel" maxlength="24" dir="ltr" required></label>
      <div class="modal-actions"><button class="secondary-button" type="button" data-action="close-modal">إلغاء</button><button class="primary-button" type="submit">بدء المحادثة</button></div></form>`);
    $("#contact-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const name = String(form.get("name") || "").trim();
      const phone = String(form.get("phone") || "").trim();
      if (name.length < 2 || phone.replace(/\D/g, "").length < 7) {
        showToast("تحقق من الاسم ورقم الهاتف.");
        return;
      }
      createChat(name, phone);
    });
  }

  function addStatus() {
    const draft = { mode: "text", file: null, background: "mint", previewUrl: null, text: "" };
    currentStatusDraft = draft;

    function renderComposer() {
      const textMode = draft.mode === "text";
      const background = statusBackgrounds[draft.background];
      const preview = `<div class="status-composer-preview ${textMode ? "text-preview" : ""}" style="background:${background}">
        ${draft.file ? draft.file.type.startsWith("video/") ? `<video src="${draft.previewUrl}" controls playsinline></video>` : `<img src="${draft.previewUrl}" alt="معاينة الحالة">` : ""}
        <textarea name="text" maxlength="240" placeholder="${textMode ? "اكتب ما يدور في بالك..." : "أضف تعليقًا (اختياري)"}" aria-label="نص الحالة">${escapeHtml(draft.text)}</textarea>
        ${textMode ? `<span class="preview-hint">معاينة حالتك</span>` : ""}
      </div>`;
      openModal(`<div class="modal-header"><h2 id="modal-title">إنشاء حالة</h2><button class="modal-close" data-action="close-modal" aria-label="إغلاق">×</button></div>
        <div class="status-mode-tabs">
          <button class="status-mode-tab ${draft.mode === "text" ? "selected" : ""}" data-action="status-mode" data-mode="text">نص</button>
              <button class="status-mode-tab ${draft.mode === "media" ? "selected" : ""}" data-action="status-mode" data-mode="media">من المعرض</button>
        </div>
        ${preview}
        ${textMode ? `<div class="background-picker" aria-label="خلفية الحالة">
          ${Object.keys(statusBackgrounds).map((key) => `<button class="background-swatch ${draft.background === key ? "selected" : ""}" data-action="status-background" data-background="${key}" style="background:${statusBackgrounds[key]}" aria-label="خلفية ${key}"></button>`).join("")}
        </div>` : `        <div class="gallery-picker"><button class="secondary-button" data-action="choose-status-media">▧ &nbsp; ${draft.file ? "اختيار ملف آخر" : "اختيار صورة أو فيديو من المعرض"}</button><span>${draft.file ? escapeHtml(draft.file.name) : "أضف صورة أو مقطع فيديو واحدًا"}</span><input id="status-media-input" class="visually-hidden" type="file" accept="image/*,video/*" hidden></div>`}
        <p class="modal-copy status-local-note">تُحفظ الحالة على جهازك لمدة 24 ساعة. الحد الأقصى للصورة أو الفيديو 50 ميغابايت.</p>
        <div class="modal-actions"><button class="secondary-button" data-action="close-modal">إلغاء</button><button class="primary-button" data-action="publish-status">نشر الحالة</button></div>`);

      $$("[data-action='status-mode']", $("#modal-card")).forEach((button) => button.addEventListener("click", () => {
        draft.text = $("#modal-card textarea[name='text']")?.value || "";
        draft.mode = button.dataset.mode;
        renderComposer();
      }));
      $$("[data-action='status-background']", $("#modal-card")).forEach((button) => button.addEventListener("click", () => {
        draft.text = $("#modal-card textarea[name='text']")?.value || "";
        draft.background = button.dataset.background;
        renderComposer();
      }));
      $("#modal-card textarea[name='text']").addEventListener("input", (event) => {
        draft.text = event.currentTarget.value;
      });
      const mediaInput = $("#status-media-input");
      if (mediaInput) mediaInput.addEventListener("change", () => {
        const file = mediaInput.files?.[0];
        if (!file) return;
        draft.text = $("#modal-card textarea[name='text']")?.value || "";
        if (!file.type.startsWith("image/") && !file.type.startsWith("video/")) {
          showToast("اختر صورة أو فيديو صالحًا.");
          return;
        }
        if (file.size > MAX_MEDIA_SIZE) {
          showToast("حجم الملف أكبر من الحد الأقصى البالغ 50 ميغابايت.");
          mediaInput.value = "";
          return;
        }
        if (draft.previewUrl) URL.revokeObjectURL(draft.previewUrl);
        draft.file = file;
        draft.previewUrl = URL.createObjectURL(file);
        draft.mode = "media";
        renderComposer();
      });
    }

    renderComposer();
  }

  async function publishStatus() {
    const text = $("#modal-card textarea[name='text']")?.value.trim() || "";
    const mode = currentStatusDraft?.mode || "text";
    const currentFile = currentStatusDraft?.file || null;
    if (mode === "text" && !text) {
      showToast("اكتب نص الحالة أولًا.");
      return;
    }

    if (mode === "media" && !currentFile) {
      showToast("اختر صورة أو فيديو من جهازك أولًا.");
      return;
    }
    try {
      const mediaKey = currentFile ? await storeMedia(currentFile) : null;
      const status = {
        id: crypto.randomUUID(),
        text,
        background: mode === "text" ? currentStatusDraft?.background || "mint" : null,
        mediaKey,
        mediaType: currentFile?.type || null,
        createdAt: Date.now()
      };
      state.statuses.push(status);
      saveState();
      closeModal();
      renderPage();
      showToast("نُشرت حالتك على هذا الجهاز.");
    } catch (error) {
      console.error("تعذر نشر الحالة.", error);
      showToast("تعذر حفظ الحالة. تحقق من مساحة التخزين المتاحة.");
    }
  }

  function closeStoryViewer() {
    window.clearTimeout(storyTimer);
    storyTimer = null;
    viewedStatusId = null;
    closeModal();
    $("#modal-card").classList.remove("story-modal");
    $("#modal-backdrop").classList.remove("story-backdrop");
  }

  function renderStoryViewer(statusId) {
    const statuses = state.statuses.filter((status) => Date.now() - status.createdAt < 24 * 60 * 60 * 1000);
    const index = statuses.findIndex((status) => status.id === statusId);
    const status = statuses[index];
    if (!status) {
      closeStoryViewer();
      showToast("انتهت صلاحية هذه الحالة أو لم تعد متاحة.");
      return;
    }

    viewedStatusId = status.id;
    const progress = statuses.map((item, itemIndex) => {
      const value = itemIndex < index ? 100 : 0;
      const duration = status.mediaType?.startsWith("video/") ? 15 : 5;
      return `<span class="story-progress-segment ${itemIndex === index ? "current" : ""}"><i style="--progress:${value}%;--duration:${duration}s"></i></span>`;
    }).join("");
    const background = status.background && statusBackgrounds[status.background] ? statusBackgrounds[status.background] : "linear-gradient(145deg, #18352f, #15212d)";
    const media = status.mediaKey ? mediaMarkup(status, "status-viewer-media") : `<div class="status-viewer-text">${escapeHtml(status.text)}</div>`;
    $("#modal-card").innerHTML = `<div class="status-viewer" style="background:${background}" data-status-index="${index}">
      <div class="story-progress">${progress}</div>
      <div class="status-viewer-top"><span>${avatarMarkup(state.profile.name, state.profile.photoKey, "avatar")}<span><strong>${escapeHtml(state.profile.name)}</strong><small>${displayTime(status.createdAt)} · تنتهي بعد 24 ساعة</small></span></span><button class="modal-close" data-action="close-story" aria-label="إغلاق">×</button></div>
      ${media}${status.mediaKey && status.text ? `<div class="status-viewer-caption">${escapeHtml(status.text)}</div>` : ""}
      <button class="story-hit-area story-hit-previous" data-action="story-previous" aria-label="الحالة السابقة"></button>
      <button class="story-hit-area story-hit-next" data-action="story-next" aria-label="الحالة التالية"></button>
    </div>`;
    $("#modal-backdrop").classList.remove("hidden");
    $("#modal-backdrop").classList.add("story-backdrop");
    $("#modal-card").classList.add("story-modal");
    hydrateMedia($("#modal-card"));

    window.clearTimeout(storyTimer);
    const video = $(".status-viewer-media", $("#modal-card"));
    if (video instanceof HTMLVideoElement) {
      video.addEventListener("ended", nextStory, { once: true });
      storyTimer = window.setTimeout(nextStory, Math.max(5000, Math.min(30000, (video.duration || 15) * 1000)));
    } else {
      const duration = status.mediaType?.startsWith("video/") ? 15000 : 5000;
      storyTimer = window.setTimeout(nextStory, duration);
    }
  }

  function viewStatus(statusId) {
    renderStoryViewer(statusId);
  }

  function nextStory() {
    const statuses = state.statuses.filter((status) => Date.now() - status.createdAt < 24 * 60 * 60 * 1000);
    const index = statuses.findIndex((status) => status.id === viewedStatusId);
    if (index < 0 || index + 1 >= statuses.length) {
      closeStoryViewer();
      return;
    }
    renderStoryViewer(statuses[index + 1].id);
  }

  function previousStory() {
    const statuses = state.statuses.filter((status) => Date.now() - status.createdAt < 24 * 60 * 60 * 1000);
    const index = statuses.findIndex((status) => status.id === viewedStatusId);
    if (index <= 0) return;
    renderStoryViewer(statuses[index - 1].id);
  }

  async function chooseProfilePhoto() {
    const input = $("#profile-photo-input");
    if (!input) return;
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        showToast("اختر ملف صورة صالحًا.");
        input.value = "";
        return;
      }
      if (file.size > MAX_MEDIA_SIZE) {
        showToast("حجم الصورة أكبر من الحد الأقصى البالغ 50 ميغابايت.");
        input.value = "";
        return;
      }
      try {
        const avatarData = await avatarDataUrl(file);
        const result = await apiRequest("/api/me", { method: "PATCH", body: { avatarData } });
        state.profile = result.user;
        saveState();
        syncProfileAvatar();
        renderProfile();
        showToast("تم تحديث الصورة الشخصية على الخادم.");
      } catch (error) {
        console.error("تعذر حفظ الصورة الشخصية.", error);
        showToast("تعذر حفظ الصورة. تحقق من مساحة التخزين المتاحة.");
      }
    };
    input.click();
  }

  async function removeMedia(key) {
    const database = await openMediaDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("media", "readwrite");
      transaction.objectStore("media").delete(key);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("تعذر حذف الوسيط."));
    });
    const url = mediaUrls.get(key);
    if (url) URL.revokeObjectURL(url);
    mediaUrls.delete(key);
  }

  async function clearMediaStorage() {
    const database = await openMediaDatabase();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("media", "readwrite");
      transaction.objectStore("media").clear();
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("تعذر مسح الوسائط."));
      transaction.onabort = () => reject(transaction.error || new Error("أُلغي مسح الوسائط."));
    });
    for (const url of mediaUrls.values()) URL.revokeObjectURL(url);
    mediaUrls.clear();
  }

  function startCall(type, chatId) {
    const chat = state.chats.find((item) => item.id === chatId);
    if (!chat) return;
    state.calls.push({ chatId, name: chat.name, type, status: "واجهة تجريبية", createdAt: Date.now() });
    saveState();
    showToast(`المكالمة ${type === "فيديو" ? "المرئية" : "الصوتية"} غير متاحة في النموذج التجريبي.`);
    if (activePage === "calls") renderCalls();
  }

  function reportChat() {
    const chat = state.chats.find((item) => item.id === activeChatId);
    if (!chat) return;
    openModal(`<div class="modal-header"><h2 id="modal-title">الإبلاغ عن مستخدم</h2><button class="modal-close" data-action="close-modal" aria-label="إغلاق">×</button></div>
      <p class="modal-copy">اختر سببًا لإرسال بلاغ تجريبي. لا تُرفق الرسائل أو أي محتوى خاص.</p>
      <form id="report-form"><label class="form-field"><span>السبب</span><select name="reason" required><option value="">اختر السبب</option><option>رسائل مزعجة</option><option>انتحال شخصية</option><option>محتوى غير لائق</option><option>سبب آخر</option></select></label>
      <div class="modal-actions"><button class="secondary-button" type="button" data-action="close-modal">إلغاء</button><button class="primary-button" type="submit">إرسال البلاغ</button></div></form>`);
    $("#report-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const reason = String(new FormData(event.currentTarget).get("reason") || "");
      if (!reason) return;
      state.reports.push({ name: chat.name, reason, createdAt: Date.now() });
      saveState();
      closeModal();
      showToast("تم تسجيل البلاغ محليًا.");
    });
  }

  document.addEventListener("click", (event) => {
    const pageButton = event.target.closest("[data-page]");
    if (pageButton) {
      activePage = pageButton.dataset.page;
      if (activePage !== "chats") activeChatId = null;
      document.body.classList.toggle("mobile-page", activePage !== "chats" || !!activeChatId);
      renderPage();
      return;
    }
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) return;
    const { action } = actionButton.dataset;
    if (action === "new-chat") openNewChat();
    if (action === "profile") {
      activePage = "profile";
      document.body.classList.add("mobile-page");
      renderPage();
    }
    if (action === "back") {
      activeChatId = null;
      document.body.classList.remove("mobile-page");
      renderPage();
    }
    if (action === "close-modal") closeModal();
    if (action === "close-story") closeStoryViewer();
    if (action === "story-next") nextStory();
    if (action === "story-previous") previousStory();
    if (action === "pick-contacts") pickContacts();
    if (action === "manual-contact") openManualContact();
    if (action === "add-status") addStatus();
    if (action === "publish-status") publishStatus();
    if (action === "choose-status-media") $("#status-media-input")?.click();
    if (action === "pick-profile-photo") chooseProfilePhoto();
    if (action === "view-status") viewStatus(actionButton.dataset.statusId);
    if (action === "audio-call") startCall("صوت", activeChatId);
    if (action === "video-call") startCall("فيديو", activeChatId);
    if (action === "toggle-favorite") toggleFavorite(activeChatId);
    if (action === "report-chat") reportChat();
    if (action === "repeat-call") startCall("صوت", actionButton.dataset.chatId);
    if (action === "edit-profile") editProfile();
    if (action === "privacy-info") showToast("لا تُعرض المحادثات أو المكالمات للمشرف في هذا التصميم.");
    if (action === "storage-info") showToast("البيانات محفوظة محليًا في هذا المتصفح فقط.");
    if (action === "clear-data") confirmClearData();
    if (action === "logout") logout();
    if (action === "admin-login") {
      authMode = "admin";
      renderAuth();
    }
    if (action === "cancel-admin-login") {
      activePage = "chats";
      document.body.classList.remove("mobile-page");
      renderPage();
    }
    if (action === "admin-logout") logout();
  });

  function editProfile() {
    openModal(`<div class="modal-header"><h2 id="modal-title">تعديل الملف</h2><button class="modal-close" data-action="close-modal" aria-label="إغلاق">×</button></div>
      <form id="edit-profile-form"><label class="form-field"><span>الاسم</span><input name="name" maxlength="48" value="${escapeHtml(state.profile.name)}" required></label>
      <label class="form-field"><span>اسم المستخدم</span><input name="username" maxlength="24" dir="ltr" value="${escapeHtml(state.profile.username || "")}" placeholder="@username"></label>
      <div class="modal-actions"><button class="secondary-button" type="button" data-action="close-modal">إلغاء</button><button class="primary-button" type="submit">حفظ</button></div></form>`);
    $("#edit-profile-form").addEventListener("submit", (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      const name = String(form.get("name") || "").trim();
      const username = String(form.get("username") || "").trim().replace(/^@/, "");
      if (name.length < 2) {
        showToast("تحقق من الاسم.");
        return;
      }
      void apiRequest("/api/me", { method: "PATCH", body: { name, username } }).then((result) => {
        state.profile = result.user;
        saveState();
        syncProfileAvatar();
        closeModal();
        renderProfile();
        showToast("تم تحديث الملف الشخصي.");
      }).catch((error) => showToast(error.message));
    });
  }

  function confirmClearData() {
    openModal(`<div class="modal-header"><h2 id="modal-title">مسح بيانات NEXVO</h2><button class="modal-close" data-action="close-modal" aria-label="إغلاق">×</button></div>
      <p class="modal-copy">سيؤدي هذا إلى حذف الملف والمحادثات والحالات والبلاغات المحفوظة في هذا المتصفح. لا يمكن التراجع عن ذلك.</p>
      <div class="modal-actions"><button class="secondary-button" data-action="close-modal">إلغاء</button><button class="danger-button" data-action="confirm-clear">مسح البيانات</button></div>`);
  }

  function logout() {
    void (async () => {
      try {
        await apiRequest("/api/auth/logout", { method: "POST", body: {} });
        state.profile = null;
        activePage = "chats";
        activeChatId = null;
        authMode = "login";
        state.chats = [];
        state.statuses = [];
        state.calls = [];
        state.reports = [];
        saveState();
        syncProfileAvatar();
        renderAuth();
      } catch (error) {
        showToast(error.message);
      }
    })();
  }

  async function initializeApplication() {
    try {
      const brand = await apiRequest("/api/brand");
      applyBrandConfiguration(brand);
    } catch (error) {
      console.error("تعذر تحميل إعدادات العلامة التجارية.", error);
    }
    try {
      const session = await apiRequest("/api/me");
      state.profile = session.user;
      syncProfileAvatar();
      renderPage();
    } catch (error) {
      if (error.status !== 401) showToast(`تعذر الاتصال بخادم NEXVO: ${error.message}`);
      state.profile = null;
      syncProfileAvatar();
      renderPage();
      authMode = "register";
      renderAuth();
    }
    scheduleStatusExpiry();
  }

  function scheduleStatusExpiry() {
    window.clearTimeout(statusExpiryTimer);
    const nextExpiration = state.statuses
      .map((status) => status.createdAt + 24 * 60 * 60 * 1000)
      .filter((expiration) => expiration > Date.now())
      .sort((a, b) => a - b)[0];
    if (!nextExpiration) return;
    statusExpiryTimer = window.setTimeout(() => {
      cleanExpiredStatuses();
      renderInbox();
      if (["chats", "updates", "profile"].includes(activePage)) renderPage();
      scheduleStatusExpiry();
    }, Math.max(0, nextExpiration - Date.now()));
  }

  function toggleFavorite(chatId) {
    const chat = state.chats.find((item) => item.id === chatId);
    if (!chat) return;
    chat.favorite = !chat.favorite;
    saveState();
    renderInbox();
    renderChat(chat);
    showToast(chat.favorite ? "أُضيفت إلى المفضلة." : "أُزيلت من المفضلة.");
  }

  document.addEventListener("click", async (event) => {
    if (event.target.closest("[data-action='confirm-clear']")) {
      try {
        await clearMediaStorage();
      } catch (error) {
        console.error("تعذر مسح وسائط NEXVO المحلية.", error);
        showToast("تعذر مسح الوسائط. حاول مجددًا.");
        return;
      }
      localStorage.removeItem(STORAGE_KEY);
      state = structuredClone(initialState);
      activeChatId = null;
      activePage = "chats";
      closeModal();
      $("#auth-overlay")?.remove();
      renderAuth();
    }
  });

  $("#search-input").addEventListener("input", renderInbox);
  $$(".filter-chip").forEach((button) => button.addEventListener("click", () => {
    activeFilter = button.dataset.filter;
    $$(".filter-chip").forEach((chip) => chip.classList.toggle("selected", chip === button));
    renderInbox();
  }));
  $("#modal-backdrop").addEventListener("click", (event) => {
    if (event.target.id === "modal-backdrop") {
      if ($("#modal-card").classList.contains("story-modal")) closeStoryViewer();
      else closeModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") $("#modal-card").classList.contains("story-modal") ? closeStoryViewer() : closeModal();
    if ($("#modal-card").classList.contains("story-modal") && event.key === "ArrowRight") nextStory();
    if ($("#modal-card").classList.contains("story-modal") && event.key === "ArrowLeft") previousStory();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      $("#search-input").focus();
    }
  });
  let storyPointerX = null;
  $("#modal-card").addEventListener("pointerdown", (event) => {
    if ($("#modal-card").classList.contains("story-modal")) storyPointerX = event.clientX;
  });
  $("#modal-card").addEventListener("pointerup", (event) => {
    if (storyPointerX === null) return;
    const difference = event.clientX - storyPointerX;
    storyPointerX = null;
    if (Math.abs(difference) > 55) difference > 0 ? previousStory() : nextStory();
  });

  syncProfileAvatar();
  void initializeApplication();
})();
