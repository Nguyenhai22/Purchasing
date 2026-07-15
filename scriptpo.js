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
let suppliers = [];
let products = [];
let currentStatusFilter = "all";
let currentQuickFilter = "all";
let searchTerm = "";
let editingId = null;
let detailId = null;
let currentSessionUser = null;
let currentView = localStorage.getItem("po_tracker_view") || "card";
let selectedIds = new Set();
const PAGE_SIZE = 20;
let currentPage = 1;
let editingSupplierId = null;
let editingProductId = null;

/* ========================= NHẬP DỮ LIỆU TỪ EXCEL (RFQ-MASTER-PUR) ========================= */
// excelPoGroups: { [maDon]: { code, supplier, contact, owner, pic_mua_hang, order_date, due_date, notes, status, excel_status, items:[] } }
let excelPoGroups = {};
let excelGroupCount = 0;

const EXCEL_SHEET_NAME = "2.PO_Manager_PUR";
const EXCEL_HEADER_ROW_INDEX = 0; // Dòng 1: tên cột kỹ thuật (Dmh_So, Ncc_Ten, Pic_MuaHang...)
const EXCEL_DATA_START_INDEX = 4; // Dữ liệu thật bắt đầu từ dòng 5 (bỏ 3 dòng tiêu đề nhóm/mẫu)

// Trạng thái mua hàng trong file Excel -> trạng thái luồng xử lý của ứng dụng.
// Ứng dụng hiện không có trạng thái "Đã hủy" riêng nên đơn Canceled được nhập
// với trạng thái "ordered" và ghi rõ trong Ghi chú để không mất thông tin gốc.
const EXCEL_STATUS_LIST = ["Canceled", "Completed", "Invoiced", "Pending", "Processing", "Stock"];
const EXCEL_STATUS_LABEL_VI = {
  Canceled: "Đã hủy", Completed: "Hoàn thành", Invoiced: "Đã xuất hóa đơn",
  Pending: "Chờ xử lý", Processing: "Đang xử lý", Stock: "Đã nhập kho"
};
const EXCEL_STATUS_TO_APP = {
  Pending: "ordered", Processing: "producing", Stock: "received",
  Invoiced: "done", Completed: "done", Canceled: "ordered"
};

// Excel lưu ngày dưới dạng số serial (số ngày kể từ 1899-12-30)
function excelSerialToISO(serial) {
  if (serial === null || serial === undefined || serial === "" || isNaN(serial)) return null;
  const utcDays = Math.floor(Number(serial) - 25569);
  const utcValue = utcDays * 86400;
  const d = new Date(utcValue * 1000);
  if (isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

function cleanExcelText(v) {
  if (v === null || v === undefined) return "";
  const s = String(v).trim();
  return s;
}

function readExcelFileAsWorkbook(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target.result);
        const wb = XLSX.read(data, { type: "array" });
        resolve(wb);
      } catch (err) { reject(err); }
    };
    reader.onerror = () => reject(new Error("Không thể đọc file."));
    reader.readAsArrayBuffer(file);
  });
}

// Gom các dòng chi tiết (mỗi dòng = 1 mặt hàng) trong sheet 2.PO_Manager_PUR
// thành các đơn mua hàng theo "Số ĐMH" (Dmh_So).
function buildExcelGroupsFromWorkbook(wb) {
  const sheet = wb.Sheets[EXCEL_SHEET_NAME];
  if (!sheet) throw new Error(`Không tìm thấy sheet "${EXCEL_SHEET_NAME}" trong file.`);

  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: null });
  const headers = rows[EXCEL_HEADER_ROW_INDEX];
  const idx = {};
  headers.forEach((h, i) => { if (h) idx[h] = i; });

  const required = ["DonHang_So", "Ncc_Ten", "TenHang_Mua", "Pic_MuaHang", "TrangThai_Mua"];
  for (const key of required) {
    if (!(key in idx)) throw new Error(`Thiếu cột "${key}" trong sheet — kiểm tra lại file/tên sheet.`);
  }

  const groups = {};
  for (let r = EXCEL_DATA_START_INDEX; r < rows.length; r++) {
    const row = rows[r];
    if (!row) continue;
    const donHangSo = row[idx.DonHang_So];
    if (!donHangSo) continue; // dòng trống / dòng công thức chưa có dữ liệu

    // Mã đơn hàng lấy đúng từ cột "Số PO (*)" (DonHang_So) theo yêu cầu.
    const code = cleanExcelText(donHangSo);

    const itemName = cleanExcelText(row[idx.TenHang_Mua]) || cleanExcelText(row[idx.TenHang_Ban]);
    const qty = Number(row[idx.SoLuong_Mua]) || Number(row[idx.SoLuong_Ban]) || 0;
    const price = Number(row[idx.DonGia_Mua_ChuaVat]) || 0;
    const received = Number(row[idx.SoLuong_NhapKho]) || 0;
    const status = cleanExcelText(row[idx.TrangThai_Mua]) || "Pending";
    // Đơn vị tính (DVT): ưu tiên cột riêng cho hàng mua, dự phòng các cột DVT khác
    const unit = cleanExcelText(row[idx.Dvt_Mua]) || cleanExcelText(row[idx.Dvt]) || cleanExcelText(row[idx.Dvt_Ban]);
    // %VAT: cột lưu dạng số thập phân (0.08 = 8%) -> quy đổi ra phần trăm để hiển thị
    const vatRaw = (row[idx.ThueVat_Mua] !== null && row[idx.ThueVat_Mua] !== undefined) ? row[idx.ThueVat_Mua] : row[idx.ThueVat_Ban];
    const vatPercent = vatRaw ? Math.round(Number(vatRaw) * 10000) / 100 : 0;

    if (!groups[code]) {
      groups[code] = {
        code,
        supplier: cleanExcelText(row[idx.Ncc_Ten]) || "Chưa rõ nhà cung cấp",
        contact: cleanExcelText(row[idx.Ncc_Ma]),
        owner: cleanExcelText(row[idx.Pic_BanHang]) || cleanExcelText(row[idx.Pic_MuaHang]) || "Chưa rõ",
        pic_mua_hang: cleanExcelText(row[idx.Pic_MuaHang]),
        // "Ngày" và "Ngày giao" là 2 cột đi liền với "Số PO (*)" trong cùng nhóm dữ liệu đơn hàng.
        order_date: excelSerialToISO(row[idx.DonHang_Ngay]) || excelSerialToISO(row[idx.Dmh_Ngay]) || todayISO(),
        due_date: excelSerialToISO(row[idx.ThoiHan_GiaoHang_Ban]) || excelSerialToISO(row[idx.ThoiHan_GiaoHang_Mua]) || excelSerialToISO(row[idx.Dbh_GiaoHang_Ngay]) || todayISO(),
        notes: status === "Canceled" ? "[Nhập từ Excel] Đơn đã bị hủy theo dữ liệu gốc." : "[Nhập từ Excel]",
        excel_status: status,
        status: EXCEL_STATUS_TO_APP[status] || "ordered",
        items: []
      };
    }
    if (itemName) {
      groups[code].items.push({
        name: itemName, unit: unit || "", qty_ordered: Math.max(qty, 1),
        unit_price: Math.max(price, 0), vat_percent: vatPercent, qty_received: Math.max(received, 0)
      });
    }
    // Nếu dòng sau có PIC Mua hàng mà nhóm chưa có, bổ sung
    if (!groups[code].pic_mua_hang && row[idx.Pic_MuaHang]) {
      groups[code].pic_mua_hang = cleanExcelText(row[idx.Pic_MuaHang]);
    }
  }

  return groups;
}

function renderImportPicCheckboxes() {
  const box = document.getElementById("importPicList");
  const counts = {};
  Object.values(excelPoGroups).forEach(g => {
    const pic = g.pic_mua_hang || "(Chưa có PIC)";
    counts[pic] = (counts[pic] || 0) + 1;
  });
  const picNames = Object.keys(counts).sort((a, b) => a.localeCompare(b, "vi"));

  box.innerHTML = picNames.map(pic => `
    <label class="import-pic-item" data-name="${escapeHtml(pic.toLowerCase())}">
      <input type="checkbox" class="import-pic-cb" value="${escapeHtml(pic)}" checked>
      ${escapeHtml(pic)} (${counts[pic]})
    </label>
  `).join("");

  box.querySelectorAll(".import-pic-cb").forEach(cb => cb.addEventListener("change", () => {
    refreshStatusCountsForSelectedPics();
    updateImportPreview();
  }));
}

function getCheckedExcelPics() {
  return new Set([...document.querySelectorAll(".import-pic-cb:checked")].map(cb => cb.value));
}

// Bộ lọc trạng thái đứng SAU bộ lọc PIC: số lượng hiển thị bên cạnh mỗi trạng thái
// luôn tính lại theo các PIC đang được chọn (không phải theo toàn bộ file).
function renderImportStatusCheckboxes() {
  const box = document.getElementById("importStatusList");

  box.innerHTML = `
    <label class="import-status-item"><input type="checkbox" id="importStatusAll" checked> <strong>(Chọn tất cả)</strong></label>
    ${EXCEL_STATUS_LIST.map(st => `
      <label class="import-status-item">
        <input type="checkbox" class="import-status-cb" value="${st}" checked>
        ${EXCEL_STATUS_LABEL_VI[st] || st} (<span class="import-status-count" data-status="${st}">0</span>)
      </label>
    `).join("")}
  `;

  document.getElementById("importStatusAll").addEventListener("change", (e) => {
    box.querySelectorAll(".import-status-cb").forEach(cb => cb.checked = e.target.checked);
    updateImportPreview();
  });
  box.querySelectorAll(".import-status-cb").forEach(cb => cb.addEventListener("change", updateImportPreview));

  refreshStatusCountsForSelectedPics();
}

// Tính lại số đơn theo từng trạng thái, chỉ trong phạm vi các PIC đang được tick,
// mà KHÔNG reset trạng thái tick/bỏ tick hiện có của các ô trạng thái.
function refreshStatusCountsForSelectedPics() {
  const checkedPics = getCheckedExcelPics();
  const counts = {};
  Object.values(excelPoGroups).forEach(g => {
    const pic = g.pic_mua_hang || "(Chưa có PIC)";
    if (!checkedPics.has(pic)) return;
    counts[g.excel_status] = (counts[g.excel_status] || 0) + 1;
  });
  document.querySelectorAll(".import-status-count").forEach(el => {
    el.textContent = counts[el.dataset.status] || 0;
  });
}

function getCheckedExcelStatuses() {
  return [...document.querySelectorAll(".import-status-cb:checked")].map(cb => cb.value);
}

function getFilteredExcelGroups() {
  const checkedStatuses = new Set(getCheckedExcelStatuses());
  const checkedPics = getCheckedExcelPics();
  return Object.values(excelPoGroups).filter(g => {
    const pic = g.pic_mua_hang || "(Chưa có PIC)";
    return checkedStatuses.has(g.excel_status) && checkedPics.has(pic);
  });
}

function shouldUpdateExisting() {
  const cb = document.getElementById("importUpdateExisting");
  return cb ? cb.checked : true;
}

function updateImportPreview() {
  const filtered = getFilteredExcelGroups();
  const existingCodes = new Set(orders.map(o => o.code));
  const newOnes = filtered.filter(g => !existingCodes.has(g.code));
  const existingOnes = filtered.filter(g => existingCodes.has(g.code));
  const updateMode = shouldUpdateExisting();

  document.getElementById("importSummary").innerHTML = `
    <span>Tổng đơn khớp bộ lọc: <strong>${filtered.length}</strong></span>
    <span>Đơn mới sẽ nhập: <strong>${newOnes.length}</strong></span>
    <span>Đơn đã tồn tại (${updateMode ? "sẽ cập nhật" : "bỏ qua"}): <strong>${existingOnes.length}</strong></span>
  `;

  const preview = filtered.slice(0, 60);
  document.getElementById("importPreviewList").innerHTML = `
    <div class="import-preview-row head"><span>Mã ĐMH</span><span>Nhà cung cấp</span><span>PIC Mua Hàng</span><span>Trạng thái</span><span>SL SP</span></div>
    ${preview.map(g => `
      <div class="import-preview-row">
        <span title="${escapeHtml(g.code)}">${escapeHtml(g.code)}${existingCodes.has(g.code) ? ` <span style="color:var(--amber);">•${updateMode ? " cập nhật" : " bỏ qua"}</span>` : ""}</span>
        <span title="${escapeHtml(g.supplier)}">${escapeHtml(g.supplier)}</span>
        <span title="${escapeHtml(g.pic_mua_hang)}">${escapeHtml(g.pic_mua_hang || "—")}</span>
        <span>${EXCEL_STATUS_LABEL_VI[g.excel_status] || g.excel_status}</span>
        <span>${g.items.length}</span>
      </div>
    `).join("")}
    ${filtered.length > 60 ? `<div style="padding:8px 10px; font-size:12px; color:var(--slate);">…và ${filtered.length - 60} đơn khác không hiển thị (vẫn sẽ được xử lý).</div>` : ""}
  `;

  const totalToProcess = newOnes.length + (updateMode ? existingOnes.length : 0);
  document.getElementById("btnRunImport").disabled = totalToProcess === 0;
}

async function handleExcelFileSelected(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!supabase) { showToast("Chưa kết nối được máy chủ dữ liệu."); return; }
  if (typeof XLSX === "undefined") { showToast("Chưa tải được thư viện đọc Excel."); return; }

  document.getElementById("importProgressLabel").textContent = "Đang đọc file...";
  try {
    const wb = await readExcelFileAsWorkbook(file);
    excelPoGroups = buildExcelGroupsFromWorkbook(wb);
    excelGroupCount = Object.keys(excelPoGroups).length;

    document.getElementById("importAfterParse").hidden = false;
    document.getElementById("importProgressLabel").textContent = `Đã đọc ${excelGroupCount} đơn mua hàng từ file.`;
    renderImportPicCheckboxes();
    renderImportStatusCheckboxes();
    updateImportPreview();
    document.getElementById("poCodeExcelHint").hidden = false;
  } catch (err) {
    document.getElementById("importProgressLabel").textContent = "";
    showToast("Lỗi đọc file Excel: " + err.message);
  }
}

async function runExcelImport() {
  if (!supabase) return;
  const filtered = getFilteredExcelGroups();
  const existingCodes = new Set(orders.map(o => o.code));
  const existingIdByCode = new Map(orders.map(o => [o.code, o.id]));
  const updateMode = shouldUpdateExisting();

  const toInsert = filtered.filter(g => !existingCodes.has(g.code));
  const toUpdate = updateMode ? filtered.filter(g => existingCodes.has(g.code)) : [];
  const totalCount = toInsert.length + toUpdate.length;

  if (totalCount === 0) { showToast("Không có đơn nào để xử lý theo bộ lọc hiện tại."); return; }

  const btn = document.getElementById("btnRunImport");
  btn.disabled = true;
  let done = 0, inserted = 0, updated = 0;
  const failures = []; // { code, stage: 'don'|'san_pham', message }

  for (const g of toInsert) {
    document.getElementById("importProgressLabel").textContent = `Đang nhập ${done + 1}/${totalCount}: ${g.code}`;
    try {
      const { data: newPo, error: poError } = await supabase
        .from("purchase_orders")
        .insert([{
          code: g.code, supplier: g.supplier, contact: g.contact, owner: g.owner,
          pic_mua_hang: g.pic_mua_hang, order_date: g.order_date, due_date: g.due_date,
          notes: g.notes, status: g.status
        }])
        .select()
        .single();

      if (poError) throw poError;

      if (g.items.length > 0) {
        const finalItems = g.items.map(it => ({ ...it, po_id: newPo.id }));
        const { error: itemsError } = await supabase.from("po_items").insert(finalItems);
        if (itemsError) {
          failures.push({ code: g.code, stage: "san_pham", message: itemsError.message });
        }
      }
      inserted++;
    } catch (err) {
      failures.push({ code: g.code, stage: "don", message: err.message });
      console.error("Lỗi nhập đơn " + g.code, err);
    }
    done++;
  }

  // Cập nhật lại các đơn đã tồn tại theo đúng PIC/trạng thái đang lọc, không cần sửa tay từng đơn.
  for (const g of toUpdate) {
    document.getElementById("importProgressLabel").textContent = `Đang cập nhật ${done + 1}/${totalCount}: ${g.code}`;
    const poId = existingIdByCode.get(g.code);
    try {
      const { error: poError } = await supabase
        .from("purchase_orders")
        .update({
          supplier: g.supplier, contact: g.contact, owner: g.owner,
          pic_mua_hang: g.pic_mua_hang, order_date: g.order_date, due_date: g.due_date,
          notes: g.notes, status: g.status
        })
        .eq("id", poId);

      if (poError) throw poError;

      const { error: delError } = await supabase.from("po_items").delete().eq("po_id", poId);
      if (delError) throw delError;

      if (g.items.length > 0) {
        const finalItems = g.items.map(it => ({ ...it, po_id: poId }));
        const { error: itemsError } = await supabase.from("po_items").insert(finalItems);
        if (itemsError) {
          failures.push({ code: g.code, stage: "san_pham", message: itemsError.message });
        }
      }
      updated++;
    } catch (err) {
      failures.push({ code: g.code, stage: "don", message: err.message });
      console.error("Lỗi cập nhật đơn " + g.code, err);
    }
    done++;
  }

  const itemFailCount = failures.filter(f => f.stage === "san_pham").length;
  const orderFailCount = failures.filter(f => f.stage === "don").length;

  if (failures.length === 0) {
    document.getElementById("importProgressLabel").textContent = `Hoàn tất: nhập mới ${inserted}, cập nhật ${updated}.`;
    showToast(`Đã nhập mới ${inserted} đơn và cập nhật ${updated} đơn từ Excel.`);
  } else {
    const firstMsg = failures[0].message;
    document.getElementById("importProgressLabel").textContent =
      `Hoàn tất với lỗi: nhập mới ${inserted}, cập nhật ${updated}, LỖI ${failures.length} (${itemFailCount} đơn thiếu sản phẩm, ${orderFailCount} đơn không lưu được).`;
    showToast(`⚠️ Có ${failures.length} lỗi khi nhập (${itemFailCount} đơn bị thiếu sản phẩm). Lỗi đầu tiên: ${firstMsg}`);
    console.error("Chi tiết các đơn lỗi khi nhập Excel:", failures);
  }

  btn.disabled = false;
  fetchOrdersFromSupabase();
  updateImportPreview();
}

function openImportModal() {
  document.getElementById("importAfterParse").hidden = true;
  document.getElementById("excelFileInput").value = "";
  document.getElementById("importProgressLabel").textContent = "";
  document.getElementById("btnRunImport").disabled = true;
  document.getElementById("importModalOverlay").hidden = false;
}
function closeImportModal() { document.getElementById("importModalOverlay").hidden = true; }

// Tự động điền toàn bộ dữ liệu đơn (NCC, ngày, PIC, sản phẩm...) khi chọn
// một mã đơn có sẵn trong dữ liệu Excel đã nhập.
function fillFormFromExcelGroup(code) {
  const g = excelPoGroups[code];
  if (!g) return;
  document.getElementById("poSupplier").value = g.supplier;
  document.getElementById("poContact").value = g.contact || "";
  document.getElementById("poOwner").value = g.owner;
  document.getElementById("poPicMuaHang").value = g.pic_mua_hang || "";
  document.getElementById("poOrderDate").value = g.order_date;
  document.getElementById("poDueDate").value = g.due_date;
  document.getElementById("poNotes").value = g.notes || "";

  const container = document.getElementById("itemsContainer");
  container.innerHTML = "";
  if (g.items.length === 0) addItemRow();
  else g.items.forEach(it => addItemRow(it));

  showToast(`Đã tự động điền dữ liệu đơn ${code} từ Excel.`);
}

/* ========================= AUTOCOMPLETE TỰ VIẾT ========================= */
// Thay thế <datalist> gốc: với modal dùng backdrop-filter, hộp gợi ý datalist
// của trình duyệt (Chrome) bị định vị sai vị trí. Dropdown tự viết dưới đây
// được gắn vào <body> và định vị bằng getBoundingClientRect nên luôn đúng vị trí.
const acDropdown = document.createElement("div");
acDropdown.className = "ac-dropdown";
acDropdown.hidden = true;
document.body.appendChild(acDropdown);
let acCurrentInput = null;

function hideAutocomplete() {
  acDropdown.hidden = true;
  acCurrentInput = null;
}

function positionAutocomplete(input) {
  const rect = input.getBoundingClientRect();
  acDropdown.style.left = rect.left + "px";
  acDropdown.style.top = (rect.bottom + 4) + "px";
  acDropdown.style.width = rect.width + "px";
}

function showAutocomplete(input, items, onSelect) {
  if (!items || items.length === 0) { hideAutocomplete(); return; }
  acCurrentInput = input;
  positionAutocomplete(input);
  acDropdown.innerHTML = items.map(name => `<div class="ac-dropdown-item" data-value="${escapeHtml(name)}">${escapeHtml(name)}</div>`).join("");
  acDropdown.hidden = false;
  acDropdown.querySelectorAll(".ac-dropdown-item").forEach(el => {
    // dùng mousedown (thay vì click) để chạy trước sự kiện blur của input
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      onSelect(el.dataset.value);
      hideAutocomplete();
    });
  });
}

function attachAutocomplete(input, getItemsFn, onSelectFn) {
  const runSearch = () => {
    const term = input.value.trim().toLowerCase();
    if (!term) { hideAutocomplete(); return; }
    showAutocomplete(input, getItemsFn(term), (val) => {
      input.value = val;
      onSelectFn(val);
    });
  };
  input.addEventListener("input", runSearch);
  input.addEventListener("focus", runSearch);
  input.addEventListener("blur", () => {
    setTimeout(() => { if (acCurrentInput === input) hideAutocomplete(); }, 120);
  });
}

window.addEventListener("scroll", () => { if (acCurrentInput) positionAutocomplete(acCurrentInput); }, true);
window.addEventListener("resize", () => { if (acCurrentInput) hideAutocomplete(); });

function matchSuggestions(list, term, limit = 8) {
  return list.filter(n => n.toLowerCase().includes(term)).slice(0, limit);
}

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
    let hasLoadedData = false;
    supabase.auth.onAuthStateChange((event, session) => {
      if (session) {
        currentSessionUser = session.user;
        if (authScreen) authScreen.style.setProperty("display", "none", "important");
        if (mainApp) mainApp.style.display = "grid";
        document.getElementById("userEmailDisplay").textContent = session.user.email;

        // QUAN TRỌNG: onAuthStateChange còn tự kích hoạt ngầm khi tab được
        // focus lại hoặc token được làm mới (TOKEN_REFRESHED), không chỉ lúc
        // đăng nhập thật sự. Nếu cứ fetch lại dữ liệu mỗi lần như vậy sẽ xóa
        // mất các lựa chọn (bulk actions) người dùng đang thao tác dở.
        // Chỉ tải dữ liệu đầy đủ 1 lần khi phiên đăng nhập được xác lập.
        if (!hasLoadedData) {
          hasLoadedData = true;
          fetchOrdersFromSupabase();
          fetchSuppliers();
          fetchProducts();
          loadZaloSettings();
        }
      } else {
        currentSessionUser = null;
        hasLoadedData = false;
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

    selectedIds.clear();
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
    const term = searchTerm.toLowerCase();
    const combinedStr = (order.code + " " + order.supplier).toLowerCase();
    const itemMatch = (order.items || []).some(it => (it.name || "").toLowerCase().includes(term));
    if (!combinedStr.includes(term) && !itemMatch) return false;
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
    document.getElementById("paginationBar").hidden = true;
    updateBulkBar(filtered);
    return;
  }
  empty.hidden = true;

  const totalCount = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  if (currentPage > totalPages) currentPage = totalPages;
  if (currentPage < 1) currentPage = 1;
  const pageStart = (currentPage - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(pageStart, pageStart + PAGE_SIZE);

  list.className = currentView === "table" ? "po-list po-list-table" : "po-list";
  list.innerHTML = currentView === "table" ? renderTableView(pageItems) : renderCardView(pageItems);

  renderPagination(totalCount, totalPages, pageStart, pageItems.length);

  // Click để mở chi tiết đơn (bỏ qua khi click vào checkbox)
  list.querySelectorAll("[data-id]").forEach(el => {
    el.addEventListener("click", (e) => {
      if (e.target.closest(".po-select-box") || e.target.classList.contains("row-select")) return;
      openDetail(el.dataset.id);
    });
  });

  // Checkbox chọn từng dòng
  list.querySelectorAll(".row-select").forEach(cb => {
    cb.checked = selectedIds.has(cb.dataset.id);
    cb.addEventListener("click", (e) => e.stopPropagation());
    cb.addEventListener("change", (e) => {
      if (e.target.checked) selectedIds.add(e.target.dataset.id);
      else selectedIds.delete(e.target.dataset.id);
      updateBulkBar(filtered);
    });
  });

  updateBulkBar(filtered);
}

function renderPagination(totalCount, totalPages, pageStart, pageLength) {
  const bar = document.getElementById("paginationBar");
  const info = document.getElementById("paginationInfo");
  const pageLabel = document.getElementById("paginationPageLabel");
  const btnPrev = document.getElementById("btnPrevPage");
  const btnNext = document.getElementById("btnNextPage");

  bar.hidden = false;
  const from = pageLength === 0 ? 0 : pageStart + 1;
  const to = pageStart + pageLength;
  info.innerHTML = `Hiển thị <strong>${from}-${to}</strong> trong tổng <strong>${totalCount}</strong> đơn`;
  pageLabel.textContent = `Trang ${currentPage}/${totalPages}`;

  btnPrev.disabled = currentPage <= 1;
  btnNext.disabled = currentPage >= totalPages;

  btnPrev.onclick = () => { if (currentPage > 1) { currentPage--; renderList(); window.scrollTo({top:0,behavior:"smooth"}); } };
  btnNext.onclick = () => { if (currentPage < totalPages) { currentPage++; renderList(); window.scrollTo({top:0,behavior:"smooth"}); } };
}

function itemNamesSummary(order) {
  const names = (order.items || []).map(it => it.name).filter(Boolean);
  if (names.length === 0) return "";
  if (names.length <= 2) return names.join(", ");
  return `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
}

function renderCardView(filtered) {
  return filtered.map(order => {
    const urg = urgency(order);
    let badge = `<span class="badge neutral">${STATUS_LABEL[order.status]}</span>`;
    if (urg === "late") badge = `<span class="badge danger">Trễ ${Math.abs(daysUntil(order.due_date))} ngày</span>`;
    else if (urg === "soon") badge = `<span class="badge warning">Còn ${daysUntil(order.due_date)} ngày</span>`;
    else if (order.status === "done") badge = `<span class="badge done">Hoàn tất</span>`;

    const itemsSummary = itemNamesSummary(order);

    return `
      <article class="po-card" data-id="${order.id}">
        <div class="po-card-top-inner">
          <div class="po-select-box">
            <input type="checkbox" class="row-select" data-id="${order.id}">
          </div>
          <div class="po-card-top" style="flex:1; margin-bottom:0;">
            <div class="po-card-main">
              <div class="po-card-id">${order.code}</div>
              <div class="po-card-supplier" title="${escapeHtml(order.supplier)}${itemsSummary ? " -- " + escapeHtml(itemsSummary) : ""}">${escapeHtml(order.supplier)}${itemsSummary ? `<span class="po-card-items"> -- ${escapeHtml(itemsSummary)}</span>` : ""}</div>
              <div class="po-card-meta">Phụ trách: <strong>${escapeHtml(order.owner)}</strong>${order.pic_mua_hang ? ` · PIC mua: <strong>${escapeHtml(order.pic_mua_hang)}</strong>` : ""}</div>
              <div class="po-card-meta">Hạn giao: ${fmtDate(order.due_date)} · Tổng: ${fmtMoney(orderTotal(order))} · ${order.items.length} mặt hàng</div>
            </div>
            ${badge}
          </div>
        </div>
        <div style="margin-top:16px;">${renderRoute(order)}</div>
      </article>
    `;
  }).join("");
}

function renderTableView(filtered) {
  const rows = filtered.map(order => {
    const urg = urgency(order);
    let badge = `<span class="badge neutral">${STATUS_LABEL[order.status]}</span>`;
    if (urg === "late") badge = `<span class="badge danger">Trễ ${Math.abs(daysUntil(order.due_date))} ngày</span>`;
    else if (urg === "soon") badge = `<span class="badge warning">Còn ${daysUntil(order.due_date)} ngày</span>`;
    else if (order.status === "done") badge = `<span class="badge done">Hoàn tất</span>`;

    return `
      <tr data-id="${order.id}">
        <td class="col-checkbox"><input type="checkbox" class="row-select" data-id="${order.id}"></td>
        <td class="col-code">${order.code}</td>
        <td class="col-supplier" title="${escapeHtml(order.supplier)}">${escapeHtml(order.supplier)}</td>
        <td>${escapeHtml(order.owner)}</td>
        <td>${escapeHtml(order.pic_mua_hang || "—")}</td>
        <td>${fmtDate(order.due_date)}</td>
        <td>${fmtMoney(orderTotal(order))}</td>
        <td>${order.items.length}</td>
        <td>${badge}</td>
      </tr>
    `;
  }).join("");

  return `
    <table class="po-table">
      <thead>
        <tr>
          <th></th>
          <th>Mã đơn</th>
          <th>Nhà cung cấp</th>
          <th>Phụ trách</th>
          <th>PIC Mua Hàng</th>
          <th>Hạn giao</th>
          <th>Tổng giá trị</th>
          <th>SL mặt hàng</th>
          <th>Trạng thái</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function updateBulkBar(filtered) {
  const bar = document.getElementById("bulkBar");
  const countLabel = document.getElementById("bulkCountLabel");
  const selectAllCb = document.getElementById("selectAllCheckbox");

  // Bỏ các id không còn hiển thị trong danh sách đã lọc hiện tại khỏi việc tính "chọn tất cả"
  const visibleIds = filtered.map(o => o.id);
  const selectedVisibleCount = visibleIds.filter(id => selectedIds.has(id)).length;

  if (selectedIds.size > 0) {
    bar.hidden = false;
    countLabel.textContent = `Đã chọn ${selectedIds.size} đơn`;
  } else {
    bar.hidden = true;
  }

  if (visibleIds.length > 0 && selectedVisibleCount === visibleIds.length) {
    selectAllCb.checked = true; selectAllCb.indeterminate = false;
  } else if (selectedVisibleCount > 0) {
    selectAllCb.checked = false; selectAllCb.indeterminate = true;
  } else {
    selectAllCb.checked = false; selectAllCb.indeterminate = false;
  }
}

function setView(view) {
  currentView = view;
  localStorage.setItem("po_tracker_view", view);
  document.getElementById("btnViewCard").classList.toggle("is-active", view === "card");
  document.getElementById("btnViewTable").classList.toggle("is-active", view === "table");
  renderList();
}

async function bulkApplyStatus() {
  const newStatus = document.getElementById("bulkStatusSelect").value;
  if (!newStatus) { showToast("Vui lòng chọn trạng thái muốn áp dụng."); return; }
  if (!supabase) { showToast("Chưa kết nối được máy chủ dữ liệu."); return; }
  if (selectedIds.size === 0) { showToast("Vui lòng tick chọn ít nhất 1 đơn hàng."); return; }

  try {
    const { error } = await supabase
      .from("purchase_orders")
      .update({ status: newStatus })
      .in("id", [...selectedIds]);
    if (error) throw error;
    showToast(`Đã cập nhật trạng thái cho ${selectedIds.size} đơn hàng.`);
    document.getElementById("bulkStatusSelect").value = "";
    fetchOrdersFromSupabase();
  } catch (err) {
    showToast("Lỗi cập nhật hàng loạt: " + err.message);
  }
}

async function bulkDeleteOrders() {
  if (!supabase) { showToast("Chưa kết nối được máy chủ dữ liệu."); return; }
  if (selectedIds.size === 0) { showToast("Vui lòng tick chọn ít nhất 1 đơn hàng."); return; }
  if (!confirm(`Bạn có chắc chắn muốn xóa vĩnh viễn ${selectedIds.size} đơn hàng đã chọn?`)) return;

  try {
    const ids = [...selectedIds];
    await supabase.from("po_items").delete().in("po_id", ids);
    const { error } = await supabase.from("purchase_orders").delete().in("id", ids);
    if (error) throw error;
    showToast(`Đã xóa ${ids.length} đơn hàng.`);
    fetchOrdersFromSupabase();
  } catch (err) {
    showToast("Lỗi khi xóa hàng loạt: " + err.message);
  }
}

/* ========================= NGHIỆP VỤ THAO TÁC CRUD ========================= */
async function savePO() {
  if (!supabase) return;
  const code = document.getElementById("poCode").value.trim();
  const supplier = document.getElementById("poSupplier").value.trim();
  const owner = document.getElementById("poOwner").value.trim();
  const picMuaHang = document.getElementById("poPicMuaHang").value.trim();
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
    const unit = row.querySelector(".item-unit").value.trim();
    const qtyOrdered = parseInt(row.querySelector(".item-qty").value) || 0;
    const unitPrice = parseFloat(row.querySelector(".item-price").value) || 0;
    const vatPercent = parseFloat(row.querySelector(".item-vat").value) || 0;
    const qtyReceived = parseInt(row.querySelector(".item-received").value) || 0;

    if (!name || qtyOrdered <= 0 || unitPrice <= 0) {
      showToast("Dữ liệu danh sách sản phẩm chưa hợp lệ.");
      return;
    }
    itemsData.push({ name, unit, qty_ordered: qtyOrdered, unit_price: unitPrice, vat_percent: vatPercent, qty_received: qtyReceived });
  }

  try {
    if (editingId) {
      // Cập nhật đơn
      const { error: poError } = await supabase
        .from("purchase_orders")
        .update({ supplier, contact, owner, pic_mua_hang: picMuaHang, order_date: orderDate, due_date: dueDate, notes })
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
        .insert([{ code, supplier, contact, owner, pic_mua_hang: picMuaHang, order_date: orderDate, due_date: dueDate, notes, status: "ordered" }])
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

/* ========================= QUẢN LÝ NHÀ CUNG CẤP ========================= */
async function fetchSuppliers() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from("suppliers").select("*").order("name", { ascending: true });
    if (error) throw error;
    suppliers = data || [];
    buildSupplierDatalist();
  } catch (err) {
    console.error("Lỗi tải nhà cung cấp:", err.message);
  }
}

function buildSupplierDatalist() {
  const dl = document.getElementById("supplierDatalist");
  if (!dl) return;
  dl.innerHTML = suppliers.map(s => `<option value="${escapeHtml(s.name)}">`).join("");
}

function supplierStats(supplierName) {
  const related = orders.filter(o => (o.supplier || "").trim().toLowerCase() === (supplierName || "").trim().toLowerCase());
  const total = related.reduce((sum, o) => sum + orderTotal(o), 0);
  return { count: related.length, total, related };
}

function renderRatingDisplay(rating) {
  const r = Number(rating) || 0;
  let out = "";
  for (let i = 1; i <= 5; i++) out += `<span class="${i <= r ? "" : "empty"}">★</span>`;
  return `<span class="rating-display">${out}</span>`;
}

function openSupplierModal() {
  fetchSuppliers().then(() => renderSupplierList());
  document.getElementById("supplierFormBox").hidden = true;
  document.getElementById("supplierSearchInput").value = "";
  document.getElementById("supplierModalOverlay").hidden = false;
}
function closeSupplierModal() { document.getElementById("supplierModalOverlay").hidden = true; }

function renderSupplierList() {
  const term = document.getElementById("supplierSearchInput").value.trim().toLowerCase();
  const box = document.getElementById("supplierList");
  const filtered = suppliers.filter(s => !term || s.name.toLowerCase().includes(term));

  if (filtered.length === 0) {
    box.innerHTML = `<div class="manage-empty">Chưa có nhà cung cấp nào. Nhấn "+ Thêm nhà cung cấp" để bắt đầu.</div>`;
    return;
  }

  box.innerHTML = filtered.map(s => {
    const stats = supplierStats(s.name);
    const subParts = [];
    if (s.contact) subParts.push(escapeHtml(s.contact));
    if (s.phone) subParts.push(escapeHtml(s.phone));
    subParts.push(`${stats.count} đơn · ${fmtMoney(stats.total)}`);
    return `
      <div class="manage-item" data-id="${s.id}">
        <div class="manage-item-main">
          <div class="manage-item-title">${escapeHtml(s.name)}</div>
          <div class="manage-item-sub">${subParts.join(" · ")}</div>
        </div>
        <div class="manage-item-side">${renderRatingDisplay(s.rating)}</div>
      </div>
    `;
  }).join("");

  box.querySelectorAll(".manage-item").forEach(el => {
    el.addEventListener("click", () => openSupplierForm(el.dataset.id));
  });
}

function openSupplierForm(id = null) {
  editingSupplierId = id;
  const box = document.getElementById("supplierFormBox");
  const supplier = id ? suppliers.find(s => s.id === id) : null;

  document.getElementById("supplierId").value = id || "";
  document.getElementById("supplierName").value = supplier ? supplier.name : "";
  document.getElementById("supplierContact").value = supplier ? (supplier.contact || "") : "";
  document.getElementById("supplierPhone").value = supplier ? (supplier.phone || "") : "";
  document.getElementById("supplierEmail").value = supplier ? (supplier.email || "") : "";
  document.getElementById("supplierAddress").value = supplier ? (supplier.address || "") : "";
  document.getElementById("supplierNotes").value = supplier ? (supplier.notes || "") : "";
  setRatingStars(supplier ? (supplier.rating || 0) : 0);
  document.getElementById("btnDeleteSupplier").hidden = !id;
  box.hidden = false;
}

function setRatingStars(rating) {
  const wrap = document.getElementById("supplierRatingStars");
  wrap.dataset.rating = rating;
  wrap.querySelectorAll("span").forEach(s => {
    s.classList.toggle("is-filled", Number(s.dataset.star) <= Number(rating));
  });
}

async function saveSupplier() {
  if (!supabase) return;
  const name = document.getElementById("supplierName").value.trim();
  if (!name) { showToast("Vui lòng nhập tên nhà cung cấp."); return; }

  const payload = {
    name,
    contact: document.getElementById("supplierContact").value.trim(),
    phone: document.getElementById("supplierPhone").value.trim(),
    email: document.getElementById("supplierEmail").value.trim(),
    address: document.getElementById("supplierAddress").value.trim(),
    rating: Number(document.getElementById("supplierRatingStars").dataset.rating) || 0,
    notes: document.getElementById("supplierNotes").value.trim()
  };

  try {
    if (editingSupplierId) {
      const { error } = await supabase.from("suppliers").update(payload).eq("id", editingSupplierId);
      if (error) throw error;
      showToast("Cập nhật nhà cung cấp thành công!");
    } else {
      const { error } = await supabase.from("suppliers").insert([payload]);
      if (error) throw error;
      showToast("Đã thêm nhà cung cấp mới!");
    }
    document.getElementById("supplierFormBox").hidden = true;
    await fetchSuppliers();
    renderSupplierList();
  } catch (err) {
    showToast("Lỗi khi lưu nhà cung cấp: " + err.message);
  }
}

async function deleteSupplier() {
  if (!editingSupplierId || !supabase) return;
  if (!confirm("Xóa nhà cung cấp này khỏi danh mục? (Các đơn hàng cũ vẫn được giữ nguyên)")) return;
  try {
    const { error } = await supabase.from("suppliers").delete().eq("id", editingSupplierId);
    if (error) throw error;
    showToast("Đã xóa nhà cung cấp.");
    document.getElementById("supplierFormBox").hidden = true;
    await fetchSuppliers();
    renderSupplierList();
  } catch (err) {
    showToast("Lỗi khi xóa nhà cung cấp: " + err.message);
  }
}

/* ========================= DANH MỤC SẢN PHẨM ========================= */
async function fetchProducts() {
  if (!supabase) return;
  try {
    const { data, error } = await supabase.from("products").select("*").order("name", { ascending: true });
    if (error) throw error;
    products = data || [];
    buildProductDatalist();
  } catch (err) {
    console.error("Lỗi tải danh mục sản phẩm:", err.message);
  }
}

function buildProductDatalist() {
  const dl = document.getElementById("productDatalist");
  if (!dl) return;
  dl.innerHTML = products.map(p => `<option value="${escapeHtml(p.name)}">`).join("");
}

function findProductByName(name) {
  const clean = (name || "").trim().toLowerCase();
  return products.find(p => p.name.trim().toLowerCase() === clean);
}

function openProductModal() {
  fetchProducts().then(() => renderProductList());
  document.getElementById("productFormBox").hidden = true;
  document.getElementById("productSearchInput").value = "";
  document.getElementById("productModalOverlay").hidden = false;
}
function closeProductModal() { document.getElementById("productModalOverlay").hidden = true; }

function productStats(productName) {
  const clean = (productName || "").trim().toLowerCase();
  let count = 0, totalQty = 0;
  orders.forEach(o => (o.items || []).forEach(it => {
    if ((it.name || "").trim().toLowerCase() === clean) { count++; totalQty += Number(it.qty_ordered) || 0; }
  }));
  return { count, totalQty };
}

function renderProductList() {
  const term = document.getElementById("productSearchInput").value.trim().toLowerCase();
  const box = document.getElementById("productList");
  const filtered = products.filter(p => !term || p.name.toLowerCase().includes(term));

  if (filtered.length === 0) {
    box.innerHTML = `<div class="manage-empty">Chưa có sản phẩm nào trong danh mục. Nhấn "+ Thêm sản phẩm" để bắt đầu.</div>`;
    return;
  }

  box.innerHTML = filtered.map(p => {
    const stats = productStats(p.name);
    const subParts = [fmtMoney(p.default_price)];
    if (p.unit) subParts.push(escapeHtml(p.unit));
    if (p.category) subParts.push(escapeHtml(p.category));
    subParts.push(`Xuất hiện trong ${stats.count} đơn`);
    return `
      <div class="manage-item" data-id="${p.id}">
        <div class="manage-item-main">
          <div class="manage-item-title">${escapeHtml(p.name)}</div>
          <div class="manage-item-sub">${subParts.join(" · ")}</div>
        </div>
      </div>
    `;
  }).join("");

  box.querySelectorAll(".manage-item").forEach(el => {
    el.addEventListener("click", () => openProductForm(el.dataset.id));
  });
}

function openProductForm(id = null) {
  editingProductId = id;
  const box = document.getElementById("productFormBox");
  const product = id ? products.find(p => p.id === id) : null;

  document.getElementById("productId").value = id || "";
  document.getElementById("productName").value = product ? product.name : "";
  document.getElementById("productPrice").value = product ? (product.default_price || "") : "";
  document.getElementById("productUnit").value = product ? (product.unit || "") : "";
  document.getElementById("productCategory").value = product ? (product.category || "") : "";
  document.getElementById("productNotes").value = product ? (product.notes || "") : "";
  document.getElementById("btnDeleteProduct").hidden = !id;
  box.hidden = false;
}

async function saveProduct() {
  if (!supabase) return;
  const name = document.getElementById("productName").value.trim();
  if (!name) { showToast("Vui lòng nhập tên sản phẩm."); return; }

  const payload = {
    name,
    default_price: parseFloat(document.getElementById("productPrice").value) || 0,
    unit: document.getElementById("productUnit").value.trim(),
    category: document.getElementById("productCategory").value.trim(),
    notes: document.getElementById("productNotes").value.trim()
  };

  try {
    if (editingProductId) {
      const { error } = await supabase.from("products").update(payload).eq("id", editingProductId);
      if (error) throw error;
      showToast("Cập nhật sản phẩm thành công!");
    } else {
      const { error } = await supabase.from("products").insert([payload]);
      if (error) throw error;
      showToast("Đã thêm sản phẩm mới vào danh mục!");
    }
    document.getElementById("productFormBox").hidden = true;
    await fetchProducts();
    renderProductList();
  } catch (err) {
    showToast("Lỗi khi lưu sản phẩm: " + err.message);
  }
}

async function deleteProduct() {
  if (!editingProductId || !supabase) return;
  if (!confirm("Xóa sản phẩm này khỏi danh mục? (Các đơn hàng cũ vẫn được giữ nguyên)")) return;
  try {
    const { error } = await supabase.from("products").delete().eq("id", editingProductId);
    if (error) throw error;
    showToast("Đã xóa sản phẩm.");
    document.getElementById("productFormBox").hidden = true;
    await fetchProducts();
    renderProductList();
  } catch (err) {
    showToast("Lỗi khi xóa sản phẩm: " + err.message);
  }
}

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
      <div><span>PIC Mua Hàng</span>${escapeHtml(order.pic_mua_hang || "—")}</div>
      <div><span>Ngày đặt hàng</span>${fmtDate(order.order_date)}</div>
      <div><span>Ngày giao dự kiến</span>${fmtDate(order.due_date)} ${urgencyNote}</div>
      <div><span>Tổng giá trị đơn</span>${fmtMoney(orderTotal(order))}</div>
    </div>
    <div class="detail-route-wrap">${renderRoute(order)}</div>
    <div class="detail-items">
      <div class="detail-item-row head"><span>Sản phẩm</span><span>ĐVT</span><span>SL đặt</span><span>Đơn giá</span><span>%VAT</span><span>Thực nhận</span></div>
      ${order.items.map(it => `<div class="detail-item-row"><span title="${escapeHtml(it.name)}">${escapeHtml(it.name)}</span><span>${escapeHtml(it.unit || "—")}</span><span>${it.qty_ordered}</span><span>${fmtMoney(it.unit_price)}</span><span>${it.vat_percent ? it.vat_percent + "%" : "—"}</span><span>${it.qty_received} / ${it.qty_ordered}</span></div>`).join("")}
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
  document.getElementById("poCodeExcelHint").hidden = excelGroupCount === 0;
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
  document.getElementById("poPicMuaHang").value = order.pic_mua_hang || "";
  document.getElementById("poOrderDate").value = order.order_date;
  document.getElementById("poDueDate").value = order.due_date;
  document.getElementById("poNotes").value = order.notes || "";
  document.getElementById("poCodeExcelHint").hidden = true;

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
    <div class="autocomplete-wrap">
      <input type="text" class="item-name" required placeholder="Tên sản phẩm..." value="${it ? escapeHtml(it.name) : ''}" autocomplete="off">
    </div>
    <input type="text" class="item-unit" placeholder="ĐVT" value="${it && it.unit ? escapeHtml(it.unit) : ''}">
    <input type="number" class="item-qty" min="1" required placeholder="SL" value="${it ? it.qty_ordered : '1'}">
    <input type="number" class="item-price" min="0" required placeholder="Giá" value="${it ? it.unit_price : ''}">
    <input type="number" class="item-vat" min="0" max="100" step="0.1" placeholder="%VAT" value="${it && it.vat_percent ? it.vat_percent : ''}">
    <input type="number" class="item-received" min="0" placeholder="Đã nhận" value="${it ? it.qty_received : '0'}">
    <button type="button" class="btn-text btn-del-item" style="padding:4px; font-weight:bold; font-size:16px;">&times;</button>
  `;
  row.querySelector(".btn-del-item").addEventListener("click", () => {
    if (container.querySelectorAll(".item-form-row").length > 1) row.remove();
    else showToast("Đơn hàng phải chứa ít nhất một sản phẩm.");
  });

  // Tự động điền đơn giá mặc định khi chọn sản phẩm có trong danh mục
  const nameInput = row.querySelector(".item-name");
  const priceInput = row.querySelector(".item-price");
  const fillPriceIfEmpty = (name) => {
    const match = findProductByName(name);
    if (match && !priceInput.value) priceInput.value = match.default_price || "";
  };
  attachAutocomplete(
    nameInput,
    (term) => matchSuggestions(products.map(p => p.name), term),
    (val) => fillPriceIfEmpty(val)
  );
  nameInput.addEventListener("change", () => fillPriceIfEmpty(nameInput.value));

  container.appendChild(row);
}

function closeModal() { document.getElementById("poModalOverlay").hidden = true; }
function closeDetail() { document.getElementById("detailOverlay").hidden = true; }
function escapeHtml(str) {
  const div = document.createElement("div"); div.textContent = str; return div.innerHTML;
}

function setupEventListeners() {
  document.getElementById("searchInput").addEventListener("input", (e) => {
    searchTerm = e.target.value; currentPage = 1; renderList();
  });

  ["filterSupplier", "filterOwner", "filterStartDate", "filterEndDate", "sortField"].forEach(id => {
    document.getElementById(id).addEventListener(id === "filterStartDate" || id === "filterEndDate" ? "input" : "change", () => {
      currentPage = 1; renderList();
    });
  });

  document.querySelectorAll(".filter-chip").forEach(chip => {
    chip.addEventListener("click", () => {
      document.querySelectorAll(".filter-chip").forEach(c => c.classList.remove("is-active"));
      chip.classList.add("is-active");
      currentStatusFilter = chip.dataset.status;
      currentPage = 1;
      renderList();
    });
  });

  document.querySelectorAll(".stat-card").forEach(card => {
    card.addEventListener("click", () => {
      currentQuickFilter = card.dataset.filter;
      currentPage = 1;
      renderList();
    });
  });

  document.getElementById("btnAddPO").addEventListener("click", openAddModal);
  attachAutocomplete(
    document.getElementById("poSupplier"),
    (term) => matchSuggestions(suppliers.map(s => s.name), term),
    () => {}
  );
  attachAutocomplete(
    document.getElementById("poCode"),
    (term) => matchSuggestions(Object.keys(excelPoGroups), term),
    (val) => fillFormFromExcelGroup(val)
  );
  attachAutocomplete(
    document.getElementById("poPicMuaHang"),
    (term) => {
      const fromOrders = orders.map(o => o.pic_mua_hang).filter(Boolean);
      const fromExcel = Object.values(excelPoGroups).map(g => g.pic_mua_hang).filter(Boolean);
      return matchSuggestions([...new Set([...fromOrders, ...fromExcel])], term);
    },
    () => {}
  );
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

  document.getElementById("btnImportExcel").addEventListener("click", openImportModal);
  document.getElementById("btnCloseImport").addEventListener("click", closeImportModal);
  document.getElementById("btnCancelImport").addEventListener("click", closeImportModal);
  document.getElementById("excelFileInput").addEventListener("change", handleExcelFileSelected);
  document.getElementById("btnRunImport").addEventListener("click", runExcelImport);
  document.getElementById("importPicSearch").addEventListener("input", (e) => {
    const term = e.target.value.trim().toLowerCase();
    document.querySelectorAll("#importPicList .import-pic-item").forEach(el => {
      el.classList.toggle("is-hidden", term && !el.dataset.name.includes(term));
    });
  });
  document.getElementById("btnImportPicAll").addEventListener("click", () => {
    document.querySelectorAll(".import-pic-cb").forEach(cb => cb.checked = true);
    refreshStatusCountsForSelectedPics();
    updateImportPreview();
  });
  document.getElementById("btnImportPicNone").addEventListener("click", () => {
    document.querySelectorAll(".import-pic-cb").forEach(cb => cb.checked = false);
    refreshStatusCountsForSelectedPics();
    updateImportPreview();
  });
  document.getElementById("importUpdateExisting").addEventListener("change", updateImportPreview);

  // Chuyển đổi chế độ xem Thẻ / Bảng
  document.getElementById("btnViewCard").addEventListener("click", () => setView("card"));
  document.getElementById("btnViewTable").addEventListener("click", () => setView("table"));
  setView(currentView);

  // Thao tác hàng loạt (bulk actions)
  document.getElementById("selectAllCheckbox").addEventListener("change", (e) => {
    const visibleIds = orders.filter(passesFilters).map(o => o.id);
    if (e.target.checked) visibleIds.forEach(id => selectedIds.add(id));
    else visibleIds.forEach(id => selectedIds.delete(id));
    renderList();
  });
  document.getElementById("btnBulkApplyStatus").addEventListener("click", bulkApplyStatus);
  document.getElementById("btnBulkDelete").addEventListener("click", bulkDeleteOrders);
  document.getElementById("btnBulkClear").addEventListener("click", () => { selectedIds.clear(); renderList(); });

  // Quản lý Nhà cung cấp
  document.getElementById("btnSuppliers").addEventListener("click", openSupplierModal);
  document.getElementById("btnCloseSupplier").addEventListener("click", closeSupplierModal);
  document.getElementById("btnNewSupplier").addEventListener("click", () => openSupplierForm(null));
  document.getElementById("btnCancelSupplierForm").addEventListener("click", () => document.getElementById("supplierFormBox").hidden = true);
  document.getElementById("btnSaveSupplier").addEventListener("click", saveSupplier);
  document.getElementById("btnDeleteSupplier").addEventListener("click", deleteSupplier);
  document.getElementById("supplierSearchInput").addEventListener("input", renderSupplierList);
  document.getElementById("supplierRatingStars").querySelectorAll("span").forEach(star => {
    star.addEventListener("click", () => setRatingStars(star.dataset.star));
  });

  // Danh mục sản phẩm
  document.getElementById("btnProducts").addEventListener("click", openProductModal);
  document.getElementById("btnCloseProduct").addEventListener("click", closeProductModal);
  document.getElementById("btnNewProduct").addEventListener("click", () => openProductForm(null));
  document.getElementById("btnCancelProductForm").addEventListener("click", () => document.getElementById("productFormBox").hidden = true);
  document.getElementById("btnSaveProduct").addEventListener("click", saveProduct);
  document.getElementById("btnDeleteProduct").addEventListener("click", deleteProduct);
  document.getElementById("productSearchInput").addEventListener("input", renderProductList);

  document.querySelectorAll(".modal-overlay").forEach(overlay => {
    overlay.addEventListener("click", (e) => { if (e.target === overlay) overlay.hidden = true; });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".modal-overlay").forEach(o => o.hidden = true);
  });
}