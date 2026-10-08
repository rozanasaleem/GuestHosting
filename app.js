const state = {
  search: "",
  tags: new Set(),
  regions: new Set(),
  matchMode: "any",
  sort: "relevance",
  selectedId: null,
  editMode: false,
  dbOnline: false,
  backend: "local",
  visibleRows: 80,
};

let guests = [];
let customFields = [];
let sourceCount = 0;
const LOCAL_STORE_KEY = "guest-directory-local-state-v1";
const INITIAL_VISIBLE_ROWS = 80;
const LOAD_MORE_ROWS = 20;

const els = {
  sourceCount: document.querySelector("#source-count"),
  search: document.querySelector("#search-input"),
  tagOptions: document.querySelector("#tag-options"),
  regionOptions: document.querySelector("#region-options"),
  tagSummary: document.querySelector("#tag-summary"),
  regionSummary: document.querySelector("#region-summary"),
  list: document.querySelector("#guest-list"),
  detail: document.querySelector("#detail-panel"),
  title: document.querySelector("#result-title"),
  statResults: document.querySelector("#stat-results"),
  statPhone: document.querySelector("#stat-with-phone"),
  statCategories: document.querySelector("#stat-categories"),
  statRegions: document.querySelector("#stat-regions"),
  commonPanel: document.querySelector("#common-panel"),
  commonCopy: document.querySelector("#common-copy"),
  commonTags: document.querySelector("#common-tags"),
  sort: document.querySelector("#sort-select"),
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

async function loadState() {
  try {
    const payload = await api("/api/state");
    guests = payload.guests.map(enrichGuest);
    customFields = payload.customFields || [];
    sourceCount = payload.sourceCount || guests.length;
    state.dbOnline = true;
    state.backend = payload.backend || "server";
    state.selectedId ||= guests[0]?.id || null;
  } catch (error) {
    state.dbOnline = false;
    state.backend = "local";
    const fallback = window.GUEST_DATABASE || { guests: [], count: 0 };
    guests = (fallback.guests || []).map((guest) => enrichGuest({ ...guest, source: "original", status: "", notes: "", custom: {} }));
    customFields = [];
    sourceCount = fallback.count || guests.length;
    applyLocalState();
    state.selectedId ||= guests[0]?.id || null;
  }
}

function readLocalState() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_STORE_KEY) || "{}");
  } catch (error) {
    return {};
  }
}

function writeLocalState(payload) {
  try {
    localStorage.setItem(LOCAL_STORE_KEY, JSON.stringify(payload));
  } catch (error) {
    alert("لم يتمكن المتصفح من حفظ التعديلات محلياً. جرّب تشغيل التطبيق من خلال server.py للحفظ في قاعدة البيانات.");
  }
}

function applyLocalState() {
  const payload = readLocalState();
  customFields = payload.customFields || [];
  (payload.guests || []).forEach((guest) => updateGuestInMemory(guest));
}

function persistLocalState() {
  writeLocalState({
    customFields,
    guests: guests.filter((guest) => guest.source === "new" || guest.localEdited),
  });
}

function clean(value) {
  return String(value || "").trim();
}

function hasVisibleName(value) {
  const name = clean(value);
  return Boolean(name && !["EMPTY", "NULL"].includes(name.toUpperCase()));
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[إأآا]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/[^\p{L}\p{N}+ ]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTags(value) {
  return clean(value)
    .replaceAll("،", ",")
    .replaceAll("/", ",")
    .replaceAll("\\", ",")
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag, index, list) => list.indexOf(tag) === index);
}

function normalizePhone(part) {
  const cleaned = clean(part)
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/(?!^)\+/g, "")
    .replace(/[^0-9+]/g, "");
  const digitCount = cleaned.replace(/\D/g, "").length;
  return digitCount >= 7 && digitCount <= 15 ? cleaned : "";
}

function splitPhones(value, existingPhones = []) {
  const rawParts = clean(value)
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, " ")
    .split(/[\s|,;،/\\]+/u);
  return [...existingPhones, ...rawParts]
    .map(normalizePhone)
    .filter(Boolean)
    .filter((phone, index, list) => list.indexOf(phone) === index);
}

function enrichGuest(record) {
  const tags = [...splitTags(record.category), ...(record.tags || [])].filter(
    (tag, index, list) => tag && list.indexOf(tag) === index,
  );
  const customText = Object.values(record.custom || {}).join(" ");
  return {
    ...record,
    tags,
    phones: splitPhones(record.phone, record.phones || []),
    custom: record.custom || {},
    searchText: [
      record.name,
      record.title,
      record.phone,
      record.category,
      record.region,
      customText,
      tags.join(" "),
    ].join(" "),
  };
}

function updateGuestInMemory(updated) {
  const enriched = enrichGuest(updated);
  const index = guests.findIndex((guest) => guest.id === enriched.id);
  if (index === -1) guests.unshift(enriched);
  else guests[index] = enriched;
}

async function updateRecord(id, patch, shouldRender = true) {
  if (!state.dbOnline) {
    const current = guests.find((guest) => guest.id === id);
    if (!current) return;
    updateGuestInMemory(mergeGuestPatch(current, patch, true));
    persistLocalState();
    if (shouldRender) render();
    return;
  }
  const updated = await api(`/api/guests/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: JSON.stringify(patch),
  });
  updateGuestInMemory(updated);
  if (shouldRender) render();
}

function mergeGuestPatch(current, patch, isLocal = false) {
  const fields = patch.fields || {};
  const custom = patch.custom || {};
  return {
    ...current,
    ...fields,
    status: patch.status === undefined ? current.status : patch.status,
    notes: patch.notes === undefined ? current.notes : patch.notes,
    custom: { ...(current.custom || {}), ...custom },
    localEdited: isLocal || current.localEdited || false,
  };
}

function countValues(rows, getter) {
  const counts = new Map();
  rows.forEach((guest) => {
    getter(guest).forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  });
  return [...counts.entries()]
    .filter(([value]) => value)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ar"));
}

function renderOptions(container, items, selectedSet, type) {
  container.innerHTML = items
    .map(
      ([label, count]) => `
        <label class="check-option">
          <input type="checkbox" data-type="${type}" value="${escapeAttr(label)}" ${selectedSet.has(label) ? "checked" : ""}>
          <span>${escapeHtml(label)}</span>
          <small>${count}</small>
        </label>
      `,
    )
    .join("");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function rtlAttr() {
  return 'dir="rtl" class="rtl-text"';
}

function scoreGuest(guest) {
  const query = normalize(state.search);
  if (!query) return 0;
  const haystack = normalize(guest.searchText);
  let score = haystack.includes(query) ? 80 : 0;
  query.split(" ").forEach((part) => {
    if (part && haystack.includes(part)) score += 6;
  });
  if (normalize(guest.name).includes(query)) score += 30;
  if (normalize(guest.category).includes(query)) score += 12;
  if (normalize(guest.region).includes(query)) score += 12;
  return score;
}

function matchesFilters(guest) {
  const query = normalize(state.search);
  if (query && scoreGuest(guest) === 0) return false;

  const selectedTags = [...state.tags];
  const selectedRegions = [...state.regions];
  const hasTag = (tag) => guest.tags?.includes(tag);
  const hasRegion = (region) => guest.region === region;

  if (state.matchMode === "all") {
    const tagMatch = selectedTags.every(hasTag);
    const regionMatch = selectedRegions.length ? selectedRegions.some(hasRegion) : true;
    return tagMatch && regionMatch;
  }

  const filters = selectedTags.length + selectedRegions.length;
  if (!filters) return true;
  return selectedTags.some(hasTag) || selectedRegions.some(hasRegion);
}

function filteredGuests() {
  const rows = guests.filter((guest) => hasVisibleName(guest.name)).filter(matchesFilters).map((guest) => ({ guest, score: scoreGuest(guest) }));

  rows.sort((a, b) => {
    if (state.sort === "name") return a.guest.name.localeCompare(b.guest.name, "ar");
    if (state.sort === "category") return (a.guest.tags?.[0] || "").localeCompare(b.guest.tags?.[0] || "", "ar");
    if (state.sort === "region") return (a.guest.region || "").localeCompare(b.guest.region || "", "ar");
    return b.score - a.score || a.guest.name.localeCompare(b.guest.name, "ar");
  });

  return rows.map((row) => row.guest);
}

function render() {
  const rows = filteredGuests();
  if (!rows.find((guest) => guest.id === state.selectedId)) {
    state.selectedId = rows[0]?.id || null;
    state.editMode = false;
  }

  const tagCounts = countValues(guests, (guest) => guest.tags || []);
  const regionCounts = countValues(guests, (guest) => (guest.region ? [guest.region] : []));
  renderOptions(els.tagOptions, tagCounts.slice(0, 80), state.tags, "tag");
  renderOptions(els.regionOptions, regionCounts.slice(0, 80), state.regions, "region");
  renderSourceCount();

  els.title.textContent = describeResults(rows.length);
  els.statResults.textContent = rows.length.toLocaleString("ar");
  els.statPhone.textContent = rows.filter((guest) => guest.phones?.length).length.toLocaleString("ar");
  els.statCategories.textContent = new Set(rows.flatMap((guest) => guest.tags || [])).size.toLocaleString("ar");
  els.statRegions.textContent = new Set(rows.map((guest) => guest.region).filter(Boolean)).size.toLocaleString("ar");

  renderList(rows);
  renderDetail(rows.find((guest) => guest.id === state.selectedId));
  renderCommon(rows);
  renderFilterSummaries();
}

function renderSourceCount() {
  const extraCount = guests.filter((guest) => guest.source === "new").length;
  const localCount = guests.filter((guest) => guest.localEdited).length;
  const onlineLabel = state.backend === "supabase" ? "محفوظ في Supabase" : "محفوظ في قاعدة البيانات";
  const status = state.dbOnline
    ? onlineLabel
    : `الحفظ محلي في هذا المتصفح${localCount ? ` · ${localCount.toLocaleString("ar")} تعديل محلي` : ""}`;
  els.sourceCount.textContent = `${guests.length.toLocaleString("ar")} ضيف، منها ${sourceCount.toLocaleString("ar")} من الملف الأصلي${extraCount ? ` و${extraCount.toLocaleString("ar")} مضاف` : ""} · ${status}`;
}

function describeResults(count) {
  const bits = [];
  if (state.search) bits.push(`بحث: ${state.search}`);
  if (state.tags.size) bits.push([...state.tags].join("، "));
  if (state.regions.size) bits.push([...state.regions].join("، "));
  if (!bits.length) return "كل الضيوف";
  return `${count.toLocaleString("ar")} نتيجة لـ ${bits.join(" / ")}`;
}

function renderList(rows) {
  if (!rows.length) {
    els.list.innerHTML = `<div class="empty-results">لا توجد نتائج مطابقة. جرّب تقليل الفلاتر أو تغيير طريقة المطابقة.</div>`;
    return;
  }

  const visibleCount = Math.min(state.visibleRows, rows.length);
  els.list.innerHTML = rows
    .slice(0, visibleCount)
    .map((guest) => {
      const tags = (guest.tags || []).slice(0, 4).map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join("");
      const region = guest.region ? `<span class="chip region">${escapeHtml(guest.region)}</span>` : "";
      const source = guest.source === "new" ? `<span class="chip raw">جديد</span>` : "";
      return `
        <button class="guest-card ${guest.id === state.selectedId ? "active" : ""}" data-id="${guest.id}" type="button">
          <span class="guest-name rtl-text" dir="rtl">${escapeHtml(guest.name)}</span>
          <span class="guest-title rtl-text" dir="rtl">${escapeHtml(guest.title || "لا يوجد وصف")}</span>
          <span class="meta">
            ${source}
            ${region}
            ${tags}
            ${guest.status ? `<span>${escapeHtml(guest.status)}</span>` : ""}
          </span>
        </button>
      `;
    })
    .join("") +
    (visibleCount < rows.length
      ? `<div class="load-more-hint">${visibleCount.toLocaleString("ar")} من ${rows.length.toLocaleString("ar")} · مرّر لعرض المزيد</div>`
      : "");
}

function resetVisibleRows() {
  state.visibleRows = INITIAL_VISIBLE_ROWS;
}

function showMoreRows() {
  const rows = filteredGuests();
  if (state.visibleRows >= rows.length) return;
  state.visibleRows = Math.min(state.visibleRows + LOAD_MORE_ROWS, rows.length);
  renderList(rows);
}

function renderDetail(guest) {
  if (!guest) {
    els.detail.innerHTML = `
      <div class="empty-detail">
        <h3>لا توجد نتيجة مختارة</h3>
        <p>غيّر البحث أو امسح الفلاتر لاختيار ضيف.</p>
      </div>
    `;
    return;
  }

  if (state.editMode) {
    renderEditDetail(guest);
    return;
  }

  const phoneLinks = (guest.phones || [])
    .map((phone) => {
      const tel = phone.startsWith("+") ? phone : `+${phone}`;
      return `
        <div class="contact-row" dir="ltr">
          <a class="contact-link ltr-phone" dir="ltr" href="tel:${escapeAttr(tel)}">${escapeHtml(phone)}</a>
          <a class="contact-link" href="https://wa.me/${escapeAttr(phone.replace("+", ""))}" target="_blank" rel="noreferrer">واتساب</a>
        </div>
      `;
    })
    .join("");

  els.detail.innerHTML = `
    <div class="detail-head">
      <div>
        <h3 class="rtl-text" dir="rtl">${escapeHtml(guest.name)}</h3>
        <p class="meta">${guest.source === "new" ? "ضيف مضاف في قاعدة البيانات" : `صف ${guest.row} في الملف الأصلي`}</p>
      </div>
      <button id="edit-guest" type="button">تعديل</button>
    </div>

    <div class="detail-section">
      <h4>حالة التواصل</h4>
      <select class="status-select" id="guest-status" aria-label="حالة التواصل">
        ${["غير محدد", "مرشح للحلقة", "تم التواصل", "استضافناه", "لا يرد", "لا نتواصل حالياً"]
          .map((status) => `<option ${guest.status === status ? "selected" : ""}>${status}</option>`)
          .join("")}
      </select>
    </div>

    <div class="detail-section">
      <h4>الوصف</h4>
      <p class="rtl-text" dir="rtl">${escapeHtml(guest.title || "لا يوجد وصف")}</p>
    </div>

    <div class="detail-section">
      <h4>الاتصال</h4>
      ${phoneLinks || "<p class='meta'>لا يوجد رقم هاتف</p>"}
    </div>

    <div class="detail-section">
      <h4>المجالات والمناطق</h4>
      <div class="chips">
        ${guest.region ? `<span class="chip region rtl-text" dir="rtl">${escapeHtml(guest.region)}</span>` : ""}
        ${(guest.tags || []).map((tag) => `<span class="chip rtl-text" dir="rtl">${escapeHtml(tag)}</span>`).join("")}
      </div>
    </div>

    ${renderCustomFields(guest)}

    <div class="detail-section">
      <h4>ملاحظات خاصة</h4>
      <textarea id="guest-notes" placeholder="موضوع مناسب، تجربة اتصال، موعد متاح..." dir="rtl" class="rtl-text">${escapeHtml(guest.notes || "")}</textarea>
    </div>
  `;
}

function renderCustomFields(guest) {
  if (!customFields.length) return "";
  return `
    <div class="detail-section">
      <h4>حقول إضافية</h4>
      ${customFields
        .map((field) => {
          const value = guest.custom?.[field.key];
          return value ? `<p ${rtlAttr()}><strong>${escapeHtml(field.label)}:</strong> ${escapeHtml(value)}</p>` : "";
        })
        .join("") || "<p class='meta'>لا توجد قيم إضافية لهذا الضيف.</p>"}
    </div>
  `;
}

function renderEditDetail(guest) {
  els.detail.innerHTML = `
    <form id="guest-form" class="edit-form">
      <div class="detail-head">
        <div>
          <h3>${guest.source === "new" ? "إضافة ضيف" : "تعديل الضيف"}</h3>
          <p class="meta">${state.dbOnline ? `سيتم الحفظ في ${state.backend === "supabase" ? "Supabase" : "قاعدة البيانات"} عند الضغط على حفظ` : "سيتم الحفظ محلياً في هذا المتصفح عند الضغط على حفظ"}</p>
        </div>
      </div>

      <label class="field">
        <span>الاسم</span>
        <input name="name" value="${escapeAttr(guest.name)}" required dir="rtl" class="rtl-text" />
      </label>
      <label class="field">
        <span>الوظيفة / الوصف</span>
        <textarea name="title" dir="rtl" class="rtl-text">${escapeHtml(guest.title || "")}</textarea>
      </label>
      <label class="field">
        <span>رقم الهاتف</span>
        <input name="phone" value="${escapeAttr(guest.phone || "")}" dir="ltr" class="ltr-phone" />
      </label>
      <label class="field">
        <span>المجال</span>
        <input name="category" value="${escapeAttr(guest.category || "")}" placeholder="مثلاً: سياسة، طب وصحة" dir="rtl" class="rtl-text" />
      </label>
      <label class="field">
        <span>المنطقة</span>
        <input name="region" value="${escapeAttr(guest.region || "")}" dir="rtl" class="rtl-text" />
      </label>

      ${customFields
        .map(
          (field) => `
            <label class="field">
              <span>${escapeHtml(field.label)}</span>
              <input name="custom:${escapeAttr(field.key)}" value="${escapeAttr(guest.custom?.[field.key] || "")}" dir="rtl" class="rtl-text" />
            </label>
          `,
        )
        .join("")}

      <div class="form-actions">
        <button type="submit">حفظ</button>
        <button class="secondary" id="cancel-edit" type="button">إلغاء</button>
      </div>
    </form>
  `;
}

function renderCommon(rows) {
  const activeFilters = state.tags.size + state.regions.size + (state.search ? 1 : 0);
  if (!rows.length || !activeFilters) {
    els.commonPanel.classList.add("hidden");
    return;
  }

  const sharedTags = intersection(rows.map((guest) => guest.tags || [])).slice(0, 8);
  const sharedRegions = intersection(rows.map((guest) => (guest.region ? [guest.region] : []))).slice(0, 4);
  const hasCommon = sharedTags.length || sharedRegions.length;
  els.commonPanel.classList.toggle("hidden", !hasCommon);
  els.commonCopy.textContent = hasCommon ? `هذه صفات تظهر عند كل النتائج الحالية أو معظمها حسب الفلاتر المختارة.` : "";
  els.commonTags.innerHTML = [
    ...sharedRegions.map((value) => `<span class="chip region">${escapeHtml(value)}</span>`),
    ...sharedTags.map((value) => `<span class="chip">${escapeHtml(value)}</span>`),
  ].join("");
}

function renderFilterSummaries() {
  els.tagSummary.textContent = summarizeSelection(state.tags, "اختر مجالاً");
  els.regionSummary.textContent = summarizeSelection(state.regions, "اختر منطقة");
}

function summarizeSelection(set, emptyLabel) {
  const values = [...set];
  if (!values.length) return emptyLabel;
  if (values.length <= 2) return values.join("، ");
  return `${values.slice(0, 2).join("، ")} +${values.length - 2}`;
}

function intersection(groups) {
  if (!groups.length) return [];
  const [first, ...rest] = groups.map((group) => new Set(group));
  return [...first].filter((value) => rest.every((group) => group.has(value)));
}

function exportCsv() {
  const rows = filteredGuests();
  const customHeaders = customFields.map((field) => field.label);
  const header = ["Name", "Title", "Phone Number", "Category", "Region", "Tags", "Status", "Notes", ...customHeaders];
  const body = rows.map((guest) => [
    guest.name,
    guest.title,
    guest.phone,
    guest.category,
    guest.region,
    (guest.tags || []).join("، "),
    guest.status || "",
    guest.notes || "",
    ...customFields.map((field) => guest.custom?.[field.key] || ""),
  ]);
  const csv = [header, ...body]
    .map((row) => row.map((cell) => `"${String(cell || "").replaceAll('"', '""')}"`).join(","))
    .join("\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = "filtered-guests.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

async function addGuest() {
  if (!state.dbOnline) {
    const guest = {
      id: `local-${Date.now()}`,
      row: "جديد",
      source: "new",
      name: "ضيف جديد",
      title: "",
      phone: "",
      category: "",
      region: "",
      status: "غير محدد",
      notes: "",
      custom: {},
      localEdited: true,
    };
    updateGuestInMemory(guest);
    persistLocalState();
    state.selectedId = guest.id;
    state.editMode = true;
    render();
    return;
  }
  const guest = await api("/api/guests", {
    method: "POST",
    body: JSON.stringify({
      fields: { name: "ضيف جديد", title: "", phone: "", category: "", region: "" },
      status: "غير محدد",
      notes: "",
      custom: {},
    }),
  });
  updateGuestInMemory(guest);
  state.selectedId = guest.id;
  state.editMode = true;
  render();
}

async function addCustomField() {
  const label = clean(window.prompt("اسم الحقل الجديد، مثلاً: المتحدث باسم / المؤسسة / موعد الاتصال"));
  if (!label) return;
  if (!state.dbOnline) {
    customFields.push({ key: `local_field_${Date.now()}`, label });
    persistLocalState();
    state.editMode = true;
    render();
    return;
  }
  const field = await api("/api/fields", {
    method: "POST",
    body: JSON.stringify({ label }),
  });
  customFields.push(field);
  state.editMode = true;
  render();
}

async function saveGuestForm(form) {
  const id = state.selectedId;
  const formData = new FormData(form);
  const fields = {
    name: clean(formData.get("name")) || "بدون اسم",
    title: clean(formData.get("title")),
    phone: clean(formData.get("phone")),
    category: clean(formData.get("category")),
    region: clean(formData.get("region")),
  };
  const custom = {};
  customFields.forEach((field) => {
    custom[field.key] = clean(formData.get(`custom:${field.key}`));
  });
  await updateRecord(id, { fields, custom }, false);
  state.editMode = false;
  render();
}

function wireEvents() {
  els.search.addEventListener("input", (event) => {
    state.search = event.target.value.trim();
    resetVisibleRows();
    render();
  });

  document.querySelectorAll(".mode-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.matchMode = button.dataset.match;
      document.querySelectorAll(".mode-button").forEach((item) => item.classList.toggle("active", item === button));
      render();
    });
  });

  document.addEventListener("change", async (event) => {
    const target = event.target;
    if (target.matches("input[type='checkbox'][data-type='tag']")) {
      target.checked ? state.tags.add(target.value) : state.tags.delete(target.value);
      resetVisibleRows();
      render();
    }
    if (target.matches("input[type='checkbox'][data-type='region']")) {
      target.checked ? state.regions.add(target.value) : state.regions.delete(target.value);
      resetVisibleRows();
      render();
    }
    if (target.id === "guest-status" && state.selectedId) {
      await updateRecord(state.selectedId, { status: target.value });
    }
  });

  document.addEventListener("input", async (event) => {
    if (event.target.id === "guest-notes" && state.selectedId) {
      await updateRecord(state.selectedId, { notes: event.target.value }, false);
    }
  });

  document.addEventListener("click", (event) => {
    const card = event.target.closest(".guest-card");
    if (card) {
      state.selectedId = card.dataset.id;
      state.editMode = false;
      render();
      return;
    }
    if (event.target.id === "edit-guest") {
      state.editMode = true;
      render();
    }
    if (event.target.id === "cancel-edit") {
      state.editMode = false;
      render();
    }
  });

  document.addEventListener("submit", async (event) => {
    if (event.target.id !== "guest-form") return;
    event.preventDefault();
    await saveGuestForm(event.target);
  });

  els.sort.addEventListener("change", (event) => {
    state.sort = event.target.value;
    resetVisibleRows();
    render();
  });

  document.querySelector("#clear-tags").addEventListener("click", () => {
    state.tags.clear();
    resetVisibleRows();
    render();
  });

  document.querySelector("#clear-regions").addEventListener("click", () => {
    state.regions.clear();
    resetVisibleRows();
    render();
  });

  document.querySelector("#clear-all").addEventListener("click", () => {
    state.search = "";
    state.tags.clear();
    state.regions.clear();
    els.search.value = "";
    resetVisibleRows();
    render();
  });

  document.querySelector("#add-guest").addEventListener("click", () => addGuest().catch(alert));
  document.querySelector("#add-field").addEventListener("click", () => addCustomField().catch(alert));
  document.querySelector("#export-csv").addEventListener("click", exportCsv);

  els.list.addEventListener("scroll", () => {
    const distanceFromBottom = els.list.scrollHeight - els.list.scrollTop - els.list.clientHeight;
    if (distanceFromBottom < 160) showMoreRows();
  });
}

async function init() {
  wireEvents();
  await loadState();
  render();
}

init();
