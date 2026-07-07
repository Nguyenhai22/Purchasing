/* ==========================================================================
   CẤU HÌNH SUPABASE CLIENT
   ========================================================================== */
const SUPABASE_URL = "https://lzgeocvfzmjheywonenf.supabase.co"; 
const SUPABASE_ANON_KEY = "sb_publishable_GYTVNGz5s917E8l245RSWQ_iTCFF6et"; 

// Khởi tạo an toàn tuyệt đối từ window hệ thống tránh lỗi 'not defined' gây crash trang
const supabase = (window.supabase && typeof window.supabase.createClient === "function") 
  ? window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY) 
  : null;

const STATUS_FLOW = ["ordered", "confirmed", "producing", "shipping", "received", "done"];
const STATUS_LABEL = {
  ordered: "Đã đặt hàng", confirmed: "NCC xác nhận", producing: "Đang chuẩn bị",
  shipping: "Đang giao hàng", received: "Đã nhận hàng", done: "Hoàn tất"
};
const STATION_SHORT = {
  ordered: "Đặt hàng", confirmed: "Xác nhận", producing: "Chuẩn bị",
  shipping: "Vận chuyển", received: "Đã nhận", done: "Hoàn tất"
};

/* ========================= TRẠNG THÁI TOÀN CỤC ========================= */
let orders = [];
let currentStatusFilter = "all";
let currentQuickFilter = "all";
let searchTerm = "";
let editingId = null;
let detailId = null;
let currentSessionUser = null;

/* ========================= KHỞI CHẠY HỆ THỐNG VÀ AUTH ========================= */
document.addEventListener("DOMContentLoaded", () => {
  initAuthLogic();
  setupEventListeners();
});

function initAuthLogic() {
  const authScreen = document.getElementById("authScreen");
  const mainApp = document.getElementById("mainApp");

  if (!supabase) {
    console.error("Thư viện Supabase CDN chưa được tải thành công. Vui lòng kiểm tra kết nối mạng!");
    alert("Không thể kết nối tới máy chủ Supabase. Vui lòng kiểm tra lại kết nối mạng!");
    if (authScreen) authScreen.style.setProperty("display", "flex", "important");
    return;
  }

  try {
    supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        currentSessionUser = session.user;
        if (authScreen) authScreen.style.setProperty("display", "none", "important");
        if (mainApp) mainApp.style.display = "grid";
        document.getElementById("userEmailDisplay").textContent = session.user.email;
        fetchOrdersFromSupabase();
        loadZaloSettings();
      } else {
        currentSessionUser = null;
        if (authScreen) authScreen.style.setProperty("display", "flex", "important");
        if (mainApp) mainApp.style.display = "none";
      }
    });
  } catch (e) {
    console.error("Lỗi đồng bộ Auth:", e);
  }

  let isSignUpMode = false;
  const authForm = document.getElementById("authForm");
  const authTitle = document.getElementById("authTitle");
  const btnAuthSubmit = document.getElementById("btnAuthSubmit");
  const tabLogin = document.getElementById("tabLogin");
  const tabRegister = document.getElementById("tabRegister");

  // Đổi tab mượt mà độc lập
  tabLogin.addEventListener("click", () => {
    isSignUpMode = false;
    authTitle.textContent = "Đăng nhập hệ thống";
    btnAuthSubmit.textContent = "Đăng nhập";
    tabLogin.classList.add("active");
    tabRegister.classList.remove("active");
  });

  tabRegister.addEventListener("click", () => {
    isSignUpMode = true;
    authTitle.textContent = "Đăng ký tài khoản mới";
    btnAuthSubmit.textContent = "Đăng ký ngay";
    tabRegister.classList.add("active");
    tabLogin.classList.remove("active");
  });

  authForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    
    const email = document.getElementById("authEmail").value.trim();
    const password = document.getElementById("authPassword").value.trim();

    if (!email || !password) {
      alert("Vui lòng nhập đầy đủ Email và Mật khẩu!");
      return;
    }
    if (password.length < 6) {
      alert("Mật khẩu phải từ 6 ký tự trở lên!");
      return;
    }

    if (isSignUpMode) {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) {
        alert("Lỗi đăng ký: " + error.message);
      } else {
        alert("Đăng ký thành công! Bạn có thể chọn tab Đăng nhập ngay bây giờ.");
        tabLogin.click();
      }
    } else {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) {
        alert("Đăng nhập thất bại: " + error.message);
      } else {
        showToast("Đăng nhập thành công!");
      }
    }
  });

  document.getElementById("btnLogout").addEventListener("click", () => {
    if (supabase) supabase.auth.signOut();
  });
}

/* ========================= ĐỒNG BỘ DỮ LIỆU DATABASE ========================= */
async function fetchOrdersFromSupabase() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase
      .from('purchase_orders')
      .select(`*, po_items(*)`)
      .order('created_at', { ascending: false });

    if (error) throw error;
    
    orders = data.map(po => ({
      ...po,
      items: po.po_items || []
    }));

    buildFilterSelectOptions();
    renderStats();
    renderList();
    simulateZaloNotifications();
  } catch (err) {
    showToast("Lỗi tải dữ liệu: " + err.message);
  }
}

function buildFilterSelectOptions() {
  const filterSupplier = document.getElementById("filterSupplier");
  const filterOwner = document.getElementById("filterOwner");

  const currentSup = filterSupplier.value;
  const currentOwn = filterOwner.value;

  const distinctSuppliers = [...new Set(orders.map(o => o.supplier))];
  const distinctOwners = [...new Set(orders.map(o => o.owner))];

  filterSupplier.innerHTML = `<option value="all">-- Tất cả nhà cung cấp --</option>` + 
    distinctSuppliers.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join("");
    
  filterOwner.innerHTML = `<option value="all">-- Tất cả phụ trách --</option>` + 
    distinctOwners.map(o => `<option value="${escapeHtml(o)}">${escapeHtml(o)}</option>`).join("");

  if (distinctSuppliers.includes(currentSup)) filterSupplier.value = currentSup;
  if (distinctOwners.includes(currentOwn)) filterOwner.value = currentOwn;
}

/* ========================= PHẦN LỌC NÂNG CAO VÀ SẮP XẾP ========================= */
function passesFilters(order) {
  if (currentStatusFilter !== "all" && order.status !== currentStatusFilter) return false;

  if (currentQuickFilter === "active" && order.status === "done") return false;
  if (currentQuickFilter === "soon" && urgency(order) !== "soon") return false;
  if (currentQuickFilter === "late" && urgency(order) !== "late") return false;

  if (searchTerm) {
    const combinedStr = (order.code + " " + order.supplier).toLowerCase();
    if (!combinedStr.includes(searchTerm.toLowerCase())) return false;
  }

  const selSupplier = document.getElementById("filterSupplier").value;
  if (selSupplier !== "all" && order.supplier !== selSupplier) return false;

  const selOwner = document.getElementById("filterOwner").value;
  if (selOwner !== "all" && order.owner !== selOwner) return false;

  const startDate = document.getElementById("filterStartDate").value;
  const endDate = document.getElementById("filterEndDate").value;
  if (startDate && order.due_date < startDate) return false;
  if (endDate && order.due_date > endDate) return false;

  return true;
}

function renderList() {
  const list = document.getElementById("poList");
  const empty = document.getElementById("emptyState");

  let filtered = orders.filter(passesFilters);

  const sortType = document.getElementById("sortField").value;
  filtered.sort((a, b) => {
    if (sortType === "due_date_asc") return new Date(a.due_date) - new Date(b.due_date);
    if (sortType === "due_date_desc") return new Date(b.due_date) - new Date(a.due_date);
    if (sortType === "total_desc") return orderTotal(b) - orderTotal(a);
    if (sortType === "total_asc") return orderTotal(a) - orderTotal(b);
    return 0;
  });

  if (filtered.length === 0) {
    list.innerHTML = "";
    empty.hidden = false;
    return;
  }
  empty.hidden = true;

  list.innerHTML = filtered.map(order => {
    const urg = urgency(order);
    let badge = `<span class="badge neutral">${STATUS_LABEL[order.status]}</span>`;
    if (urg === "late") badge = `<span class="badge danger">Trễ ${Math.abs(daysUntil(order.due_date))} ngày</span>`;
    else if (urg === "soon") badge = `<span class="badge warning">Còn ${daysUntil(order.due_date)} ngày</span>`;
    else if (order.status === "done") badge = `<span class="badge done">Hoàn tất</span>`;

    return `
      <article class="po-card" data-id="${order.id}">
        <div class="po-card-top">
          <div>
            <div class="po-card-id">${order.code}</div>
            <div class="po-card-supplier">${escapeHtml(order.supplier)}</div>
            <div class="po-card-meta">Phụ trách: <strong>${escapeHtml(order.owner)}</strong></div>
            <div class="po-card-meta">Hạn giao: ${fmtDate(order.due_date)} · Tổng: ${fmtMoney(orderTotal(order))} · ${order.items.length} mặt hàng</div>
          </div>
          ${badge}
        </div>
        ${renderRoute(order)}
      </article>
    `;
  }).join("");

  list.querySelectorAll(".po-card").forEach(card => {
    card.addEventListener("click", () => openDetail(card.dataset.id));
  });
}

/* ========================= NGHIỆP VỤ THAO TÁC CRUD ========================= */
async function savePO() {
  if (!supabase) return;
  const code = document.getElementById("poCode").value.trim();
  const supplier = document.getElementById("poSupplier").value.trim();
  const owner = document.getElementById("poOwner").value.trim();
  const orderDate = document.getElementById("poOrderDate").value;
  const dueDate = document.getElementById("poDueDate").value;
  const contact = document.getElementById("poContact").value.trim();
  const notes = document.getElementById("poNotes").value.trim();

  if (!code || !supplier || !owner || !orderDate || !dueDate) {
    showToast("Vui lòng điền đầy đủ thông tin bắt buộc (*)");
    return;
  }

  const rows = document.querySelectorAll(".item-form-row");
  const itemsData = [];
  for (let row of rows) {
    const name = row.querySelector(".item-name").value.trim();
    const qtyOrdered = parseInt(row.querySelector(".item-qty").value) || 0;
    const unitPrice = parseFloat(row.querySelector(".item-price").value) || 0;
    const qtyReceived = parseInt(row.querySelector(".item-received").value) || 0;

    if (!name || qtyOrdered <= 0 || unitPrice <= 0) {
      showToast("Dữ liệu danh sách sản phẩm chưa hợp lệ.");
      return;
    }
    itemsData.push({ name, qty_ordered: qtyOrdered, unit_price: unitPrice, qty_received: qtyReceived });
  }

  try {
    if (editingId) {
      // Cập nhật đơn
      const { error: poError } = await supabase
        .from("purchase_orders")
        .update({ supplier, contact, owner, order_date: orderDate, due_date: dueDate, notes })
        .eq("id", editingId);

      if (poError) throw poError;

      await supabase.from("po_items").delete().eq("po_id", editingId);
      if (itemsData.length > 0) {
        const finalItems = itemsData.map(it => ({ ...it, po_id: editingId }));
        await supabase.from("po_items").insert(finalItems);
      }
      showToast("Cập nhật đơn hàng thành công!");
    } else {
      // Tạo đơn với mã tự tạo (Kiểm tra trùng lặp)
      const { data: duplicateCheck } = await supabase
        .from("purchase_orders")
        .select("code")
        .eq("code", code)
        .maybeSingle();

      if (duplicateCheck) {
        alert("Mã đơn hàng này đã tồn tại! Vui lòng đặt mã khác.");
        return;
      }

      const { data: newPo, error: poError } = await supabase
        .from("purchase_orders")
        .insert([{ code, supplier, contact, owner, order_date: orderDate, due_date: dueDate, notes, status: "ordered" }])
        .select()
        .single();

      if (poError) throw poError;

      if (itemsData.length > 0) {
        const finalItems = itemsData.map(it => ({ ...it, po_id: newPo.id }));
        await supabase.from("po_items").insert(finalItems);
      }
      showToast("Tạo đơn mua hàng thành công!");
    }

    closeModal();
    fetchOrdersFromSupabase();
  } catch (err) {
    showToast("Không thể lưu dữ liệu: " + err.message);
  }
}

async function advanceStatus() {
  if (!detailId || !supabase) return;
  const order = orders.find(o => o.id === detailId);
  if (!order) return;

  const currentIdx = STATUS_FLOW.indexOf(order.status);
  if (currentIdx === STATUS_FLOW.length - 1) return;

  const nextStatus = STATUS_FLOW[currentIdx + 1];

  try {
    const { error } = await supabase
      .from("purchase_orders")
      .update({ status: nextStatus })
      .eq("id", detailId);

    if (error) throw error;
    showToast(`Đã cập nhật trạng thái đơn: ${STATUS_LABEL[nextStatus]}`);
    closeDetail();
    fetchOrdersFromSupabase();
  } catch (err) {
    showToast("Lỗi cập nhật trạng thái: " + err.message);
  }
}

async function deletePO() {
  if (!editingId || !confirm("Bạn có chắc chắn muốn xóa vĩnh viễn đơn hàng này?") || !supabase) return;
  try {
    const { error } = await supabase.from("purchase_orders").delete().eq("id", editingId);
    if (error) throw error;
    showToast("Đã xóa đơn hàng khỏi hệ thống.");
    closeModal();
    fetchOrdersFromSupabase();
  } catch (err) {
    showToast("Lỗi khi xóa đơn: " + err.message);
  }
}

/* ========================= CẤU HÌNH ZALO OA ========================= */
const ZALO_STORAGE_KEY = "po_tracker_zalo";
const ZALO_LOG_KEY = "po_tracker_notif_log";

function loadZaloSettings() {
  const saved = localStorage.getItem(ZALO_STORAGE_KEY);
  if (saved) {
    const config = JSON.parse(saved);
    document.getElementById("zaloToken").value = config.token || "";
    document.getElementById("zaloReceiver").value = config.receiver || "";
    document.getElementById("toggleSoon").checked = !!config.soon;
    document.getElementById("toggleLate").checked = !!config.late;
  }
  renderZaloLogs();
}

function saveZaloSettings() {
  const config = {
    token: document.getElementById("zaloToken").value.trim(),
    receiver: document.getElementById("zaloReceiver").value.trim(),
    soon: document.getElementById("toggleSoon").checked,
    late: document.getElementById("toggleLate").checked
  };
  localStorage.setItem(ZALO_STORAGE_KEY, JSON.stringify(config));
  showToast("Đã lưu cấu hình Zalo thành công!");
  closeZaloModal();
  simulateZaloNotifications();
}

function renderZaloLogs() {
  const logs = JSON.parse(localStorage.getItem(ZALO_LOG_KEY) || "[]");
  const box = document.getElementById("notifLog");
  if (!box) return;
  if (logs.length === 0) {
    box.innerHTML = "<em>Chưa có cảnh báo nào được kích hoạt.</em>";
  } else {
    box.innerHTML = logs.map(l => `[${l.time}] ${escapeHtml(l.text)}`).join("<br>");
  }
}

function simulateZaloNotifications() {
  const saved = localStorage.getItem(ZALO_STORAGE_KEY);
  if (!saved) return;
  const config = JSON.parse(saved);
  let logs = JSON.parse(localStorage.getItem(ZALO_LOG_KEY) || "[]");
  let triggered = false;

  orders.forEach(order => {
    const urg = urgency(order);
    if (config.soon && urg === "soon") {
      const msg = `CẢNH BÁO: Đơn hàng ${order.code} của ${order.supplier} sắp đến hạn trong vòng 2 ngày!`;
      if (!logs.some(l => l.text === msg)) {
        logs.unshift({ time: new Date().toLocaleTimeString(), text: msg });
        triggered = true;
      }
    }
    if (config.late && urg === "late") {
      const msg = `CẢNH BÁO: Đơn hàng ${order.code} của bên ${order.supplier} đã bị TRỄ HẠN giao hàng!`;
      if (!logs.some(l => l.text === msg)) {
        logs.unshift({ time: new Date().toLocaleTimeString(), text: msg });
        triggered = true;
      }
    }
  });

  if (triggered) {
    localStorage.setItem(ZALO_LOG_KEY, JSON.stringify(logs.slice(0, 30)));
    renderZaloLogs();
  }
}

function openZaloModal() { document.getElementById("zaloModalOverlay").hidden = false; }
function closeZaloModal() { document.getElementById("zaloModalOverlay").hidden = true; }

/* ========================= HÀM PHỤ TRỢ ========================= */
function todayISO() { return new Date().toISOString().slice(0, 10); }
function daysUntil(dateStr) {
  const today = new Date(todayISO());
  const target = new Date(dateStr);
  return Math.round((target - today) / (1000 * 60 * 60 * 24));
}
function urgency(order) {
  if (order.status === "done" || order.status === "received") return "none";
  const diff = daysUntil(order.due_date);
  if (diff < 0) return "late";
  if (diff <= 2) return "soon";
  return "ok";
}
function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
function fmtMoney(n) { return Number(n || 0).toLocaleString("vi-VN") + "đ"; }
function orderTotal(order) {
  return order.items.reduce((sum, it) => sum + (it.qty_ordered * it.unit_price), 0);
}
function showToast(msg) {
  const t = document.getElementById("toast");
  if (!t) return;
  t.textContent = msg; t.classList.add("show");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.remove("show"), 2600);
}

function renderStats() {
  document.getElementById("statAll").textContent = orders.length;
  document.getElementById("statActive").textContent = orders.filter(o => o.status !== "done").length;
  document.getElementById("statSoon").textContent = orders.filter(o => urgency(o) === "soon").length;
  document.getElementById("statLate").textContent = orders.filter(o => urgency(o) === "late").length;
}

function renderRoute(order) {
  const currentIdx = STATUS_FLOW.indexOf(order.status);
  return `
    <div class="route">
      ${STATUS_FLOW.map((st, idx) => {
        let cls = "station";
        if (idx < currentIdx) cls += " is-complete";
        else if (idx === currentIdx && st === "done") cls += " is-done-final";
        else if (idx === currentIdx) cls += " is-current";
        return `<div class="${cls}"><div class="line"></div><div class="dot"></div><span class="label">${STATION_SHORT[st]}</span></div>`;
      }).join("")}
    </div>
  `;
}

function openDetail(id) {
  detailId = id;
  const order = orders.find(o => o.id === id);
  if (!order) return;

  document.getElementById("detailCode").textContent = order.code;
  const urg = urgency(order);
  let urgencyNote = "";
  if (urg === "late") urgencyNote = `<span class="badge danger">Trễ hạn ${Math.abs(daysUntil(order.due_date))} ngày</span>`;
  else if (urg === "soon") urgencyNote = `<span class="badge warning">Sắp đến hạn (${daysUntil(order.due_date)} ngày)</span>`;

  document.getElementById("detailBody").innerHTML = `
    <div class="detail-grid">
      <div><span>Nhà cung cấp</span>${escapeHtml(order.supplier)}</div>
      <div><span>Liên hệ</span>${escapeHtml(order.contact || "—")}</div>
      <div><span>Người phụ trách</span>${escapeHtml(order.owner || "—")}</div>
      <div><span>Ngày đặt hàng</span>${fmtDate(order.order_date)}</div>
      <div><span>Ngày giao dự kiến</span>${fmtDate(order.due_date)} ${urgencyNote}</div>
      <div><span>Tổng giá trị đơn</span>${fmtMoney(orderTotal(order))}</div>
    </div>
    <div class="detail-route-wrap">${renderRoute(order)}</div>
    <div class="detail-items">
      <div class="detail-item-row head"><span>Sản phẩm</span><span>SL đặt</span><span>Đơn giá</span><span>Thực nhận</span></div>
      ${order.items.map(it => `<div class="detail-item-row"><span>${escapeHtml(it.name)}</span><span>${it.qty_ordered}</span><span>${fmtMoney(it.unit_price)}</span><span>${it.qty_received} / ${it.qty_ordered}</span></div>`).join("")}
    </div>
    ${order.notes ? `<div class="detail-notes">${escapeHtml(order.notes)}</div>` : ""}
  `;

  const advanceBtn = document.getElementById("btnAdvanceStatus");
  if (order.status === "done") {
    advanceBtn.disabled = true; advanceBtn.textContent = "Đơn hàng đã hoàn tất";
  } else {
    advanceBtn.disabled = false;
    const idx = STATUS_FLOW.indexOf(order.status);
    advanceBtn.textContent = `Chuyển sang: ${STATUS_LABEL[STATUS_FLOW[idx + 1]]} →`;
  }
  document.getElementById("detailOverlay").hidden = false;
}

function openAddModal() {
  editingId = null;
  document.getElementById("poForm").reset();
  document.getElementById("poId").value = "";
  
  // Cho phép tự do tạo mã đơn mới
  const codeInput = document.getElementById("poCode");
  codeInput.value = "";
  codeInput.removeAttribute("readonly");

  document.getElementById("poOrderDate").value = todayISO();
  document.getElementById("poDueDate").value = todayISO();
  document.getElementById("itemsContainer").innerHTML = "";
  document.getElementById("modalTitle").textContent = "Thêm đơn mua hàng";
  document.getElementById("btnDeletePO").hidden = true;
  addItemRow();
  document.getElementById("poModalOverlay").hidden = false;
}

function openEditModal(id) {
  editingId = id;
  const order = orders.find(o => o.id === id);
  if (!order) return;

  document.getElementById("poId").value = order.id;
  
  // Khóa ô mã đơn lại khi chỉnh sửa đơn cũ để an toàn dữ liệu
  const codeInput = document.getElementById("poCode");
  codeInput.value = order.code;
  codeInput.setAttribute("readonly", "true");

  document.getElementById("poSupplier").value = order.supplier;
  document.getElementById("poContact").value = order.contact || "";
  document.getElementById("poOwner").value = order.owner;
  document.getElementById("poOrderDate").value = order.order_date;
  document.getElementById("poDueDate").value = order.due_date;
  document.getElementById("poNotes").value = order.notes || "";

  const container = document.getElementById("itemsContainer");
  container.innerHTML = "";
  if (order.items.length === 0) addItemRow();
  else order.items.forEach(it => addItemRow(it));

  document.getElementById("modalTitle").textContent = "Chỉnh sửa đơn mua hàng";
  document.getElementById("btnDeletePO").hidden = false;
  document.getElementById("poModalOverlay").hidden = false;
}

function addItemRow(it = null) {
  const container = document.getElementById("itemsContainer");
  const row = document.createElement("div");
  row.className = "item-form-row";
  row.innerHTML = `
    <input type="text" class="item-name" required placeholder="Tên sản phẩm..." value="${it ? escapeHtml(it.name) : ''}">
    <input type="number" class="item-qty" min="1" required placeholder="SL" value="${it ? it.qty_ordered : '1'}">
    <input type="number" class="item-price" min="0" required placeholder="Giá" value="${it ? it.unit_price : ''}">
    <input type="number" class="item-received" min="0" placeholder="Đã nhận" value="${it ? it.qty_received : '0'}">
    <button type="button" class="btn-text btn-del-item" style="padding:4px; font-weight:bold; font-size:16px;">&times;</button>
  `;
  row.querySelector(".btn-del-item").addEventListener("click", () => {
    if (container.querySelectorAll(".item-form-row").length > 1) row.remove();
    else showToast("Đơn hàng phải chứa ít nhất một sản phẩm.");
  });
  container.appendChild(row);
}

function closeModal() { document.getElementById("poModalOverlay").hidden = true; }
function closeDetail() { document.getElementById("detailOverlay").hidden = true; }
function escapeHtml(str) {
  const div = document.createElement("div"); div.textContent = str; return div.innerHTML;
}

function setupEventListeners() {
  document.getElementById("searchInput").addEventListener("input", (e) => {
    searchTerm = e.target.value; renderList();
  });

  document.getElementById("filterSupplier").addEventListener("change", renderList);
  document.getElementById("filterOwner").addEventListener("change", renderList);
  document.getElementById("filterStartDate").addEventListener("input", renderList);
  document.getElementById("filterEndDate").addEventListener("input", renderList);
  document.getElementById("sortField").addEventListener("change", renderList);

  document.querySelectorAll(".filter-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      currentStatusFilter = chip.dataset.status;
      renderList();
    });
  });

  document.querySelectorAll(".stat-card").forEach(card => {
    card.addEventListener("click", () => {
      currentQuickFilter = card.dataset.filter;
      renderList();
    });
  });

  document.getElementById("btnAddPO").addEventListener("click", openAddModal);
  document.getElementById("btnCloseModal").addEventListener("click", closeModal);
  document.getElementById("btnCancelModal").addEventListener("click", closeModal);
  document.getElementById("btnSavePO").addEventListener("click", savePO);
  document.getElementById("btnDeletePO").addEventListener("click", deletePO);
  document.getElementById("btnAddItem").addEventListener("click", () => addItemRow());
  document.getElementById("btnCloseDetail").addEventListener("click", closeDetail);
  document.getElementById("btnAdvanceStatus").addEventListener("click", advanceStatus);
  
  document.getElementById("btnEditFromDetail").addEventListener("click", () => {
    const id = detailId; closeDetail(); openEditModal(id);
  });

  document.getElementById("btnZaloSettings").addEventListener("click", openZaloModal);
  document.getElementById("btnCloseZalo").addEventListener("click", closeZaloModal);
  document.getElementById("btnCancelZalo").addEventListener("click", closeZaloModal);
  document.getElementById("btnSaveZalo").addEventListener("click", saveZaloSettings);

  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.hidden = true; });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".modal-overlay").forEach(o => o.hidden = true);
  });
}