'use strict';

/* =========================================================
   Storage layer: IndexedDB with localStorage fallback
   ========================================================= */
const DB_NAME = 'bookLibraryDB';
const DB_VERSION = 1;
const STORE_NAME = 'books';
const LS_KEY = 'bookLibrary_books_v1';

let useIndexedDB = 'indexedDB' in window;
let dbPromise = null;

function openDB(){
  if(dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if(!db.objectStoreNames.contains(STORE_NAME)){
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('isbn', 'isbn', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return dbPromise;
}

function lsGetAll(){
  try{ return JSON.parse(localStorage.getItem(LS_KEY) || '[]'); }
  catch(e){ return []; }
}
function lsSaveAll(arr){ localStorage.setItem(LS_KEY, JSON.stringify(arr)); }
function lsPut(book){
  const arr = lsGetAll();
  const idx = arr.findIndex(b => b.id === book.id);
  if(idx >= 0) arr[idx] = book; else arr.push(book);
  lsSaveAll(arr);
}
function lsDelete(id){
  lsSaveAll(lsGetAll().filter(b => b.id !== id));
}

const Store = {
  async getAll(){
    if(useIndexedDB){
      try{
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readonly');
          const req = tx.objectStore(STORE_NAME).getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        });
      }catch(e){ console.warn('IndexedDB failed, falling back to localStorage', e); useIndexedDB = false; }
    }
    return lsGetAll();
  },
  async put(book){
    if(useIndexedDB){
      try{
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).put(book);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }catch(e){ console.warn('IndexedDB failed, falling back to localStorage', e); useIndexedDB = false; }
    }
    return lsPut(book);
  },
  async delete(id){
    if(useIndexedDB){
      try{
        const db = await openDB();
        return await new Promise((resolve, reject) => {
          const tx = db.transaction(STORE_NAME, 'readwrite');
          tx.objectStore(STORE_NAME).delete(id);
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
      }catch(e){ console.warn('IndexedDB failed, falling back to localStorage', e); useIndexedDB = false; }
    }
    return lsDelete(id);
  }
};

/* =========================================================
   In-memory state
   ========================================================= */
let books = [];

function genId(){
  if(window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(16).slice(2);
}

function normalizeIsbn(raw){
  return (raw || '').toString().replace(/[^0-9Xx]/g, '').toUpperCase();
}
function isLikelyIsbn13(code){
  return /^97[89]\d{10}$/.test(code);
}
function findByIsbn(isbn){
  if(!isbn) return null;
  return books.find(b => b.isbn && normalizeIsbn(b.isbn) === isbn) || null;
}

/* =========================================================
   ISBN lookup: openBD -> Google Books fallback
   ========================================================= */
async function lookupIsbn(rawIsbn){
  const isbn = normalizeIsbn(rawIsbn);
  if(!isbn) return null;

  try{
    const res = await fetch(`https://api.openbd.jp/v1/get?isbn=${encodeURIComponent(isbn)}`);
    if(res.ok){
      const data = await res.json();
      const item = data && data[0];
      if(item && item.summary && item.summary.title){
        const s = item.summary;
        return {
          isbn: s.isbn || isbn,
          title: s.title || '',
          author: s.author || '',
          publisher: s.publisher || '',
          pubdate: formatOpenBdDate(s.pubdate),
          cover: s.cover || ''
        };
      }
    }
  }catch(e){ console.warn('openBD lookup failed', e); }

  try{
    const res = await fetch(`https://www.googleapis.com/books/v1/volumes?q=isbn:${encodeURIComponent(isbn)}`);
    if(res.ok){
      const data = await res.json();
      const item = data.items && data.items[0];
      if(item && item.volumeInfo && item.volumeInfo.title){
        const v = item.volumeInfo;
        let cover = '';
        if(v.imageLinks){
          cover = v.imageLinks.thumbnail || v.imageLinks.smallThumbnail || '';
          cover = cover.replace(/^http:\/\//, 'https://');
        }
        return {
          isbn,
          title: v.title || '',
          author: (v.authors || []).join(', '),
          publisher: v.publisher || '',
          pubdate: v.publishedDate || '',
          cover
        };
      }
    }
  }catch(e){ console.warn('Google Books lookup failed', e); }

  return null;
}

function formatOpenBdDate(pubdate){
  if(!pubdate) return '';
  const digits = String(pubdate).replace(/[^0-9]/g, '');
  if(digits.length >= 8) return `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6,8)}`;
  if(digits.length >= 6) return `${digits.slice(0,4)}-${digits.slice(4,6)}`;
  if(digits.length >= 4) return digits.slice(0,4);
  return String(pubdate);
}

/* =========================================================
   Toast
   ========================================================= */
let toastTimer = null;
function showToast(msg, ms = 3200){
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

/* =========================================================
   Rendering: list / grid / search / sort
   ========================================================= */
const searchInput = document.getElementById('searchInput');
const sortSelect = document.getElementById('sortSelect');
const bookGrid = document.getElementById('bookGrid');
const emptyState = document.getElementById('emptyState');
const noResultsState = document.getElementById('noResultsState');

function getFilteredSorted(){
  const q = searchInput.value.trim().toLowerCase();
  let list = books;
  if(q){
    list = list.filter(b =>
      (b.title || '').toLowerCase().includes(q) ||
      (b.author || '').toLowerCase().includes(q)
    );
  }
  const [key, dir] = sortSelect.value.split('-');
  list = [...list].sort((a, b) => {
    let av, bv;
    if(key === 'createdAt'){ av = a.createdAt || ''; bv = b.createdAt || ''; }
    else if(key === 'title'){ av = a.title || ''; bv = b.title || ''; }
    else { av = a.author || ''; bv = b.author || ''; }
    const cmp = av.localeCompare(bv, 'ja');
    return dir === 'desc' ? -cmp : cmp;
  });
  return list;
}

function render(){
  const list = getFilteredSorted();
  bookGrid.innerHTML = '';

  emptyState.hidden = books.length !== 0;
  noResultsState.hidden = !(books.length !== 0 && list.length === 0);

  list.forEach(book => {
    const card = document.createElement('div');
    card.className = 'book-card';
    card.tabIndex = 0;

    let coverHtml;
    if(book.cover){
      coverHtml = `<img class="book-cover" src="${escapeAttr(book.cover)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'book-cover-placeholder',textContent:'📕'}))">`;
    }else{
      coverHtml = `<div class="book-cover-placeholder">📕</div>`;
    }

    card.innerHTML = `
      ${coverHtml}
      <div class="book-title">${escapeHtml(book.title || '(無題)')}</div>
      <div class="book-author">${escapeHtml(book.author || '')}</div>
    `;
    card.addEventListener('click', () => openFormModal('edit', book));
    bookGrid.appendChild(card);
  });
}

function escapeHtml(str){
  return String(str).replace(/[&<>"']/g, c => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[c]));
}
function escapeAttr(str){ return escapeHtml(str); }

searchInput.addEventListener('input', render);
sortSelect.addEventListener('change', render);

/* =========================================================
   Form modal (add / edit)
   ========================================================= */
const formModal = document.getElementById('formModal');
const bookForm = document.getElementById('bookForm');
const formTitle = document.getElementById('formTitle');
const fieldId = document.getElementById('fieldId');
const fieldIsbn = document.getElementById('fieldIsbn');
const fieldTitle = document.getElementById('fieldTitle');
const fieldAuthor = document.getElementById('fieldAuthor');
const fieldPublisher = document.getElementById('fieldPublisher');
const fieldPubdate = document.getElementById('fieldPubdate');
const fieldCover = document.getElementById('fieldCover');
const coverPreview = document.getElementById('coverPreview');
const coverFileInput = document.getElementById('coverFileInput');
const deleteBtn = document.getElementById('deleteBtn');
const dupNotice = document.getElementById('dupNotice');
const formMessage = document.getElementById('formMessage');
const formLoading = document.getElementById('formLoading');
const createdAtLine = document.getElementById('createdAtLine');

let currentEditId = null;
let currentCreatedAt = null;

function openFormModal(mode, book){
  bookForm.reset();
  dupNotice.hidden = true;
  formMessage.hidden = true;
  formLoading.hidden = true;
  coverPreview.hidden = true;
  createdAtLine.hidden = true;
  currentEditId = null;
  currentCreatedAt = null;

  if(mode === 'edit' && book){
    formTitle.textContent = '本を編集';
    fieldId.value = book.id;
    fieldIsbn.value = book.isbn || '';
    fieldTitle.value = book.title || '';
    fieldAuthor.value = book.author || '';
    fieldPublisher.value = book.publisher || '';
    fieldPubdate.value = book.pubdate || '';
    fieldCover.value = book.cover || '';
    currentEditId = book.id;
    currentCreatedAt = book.createdAt || null;
    deleteBtn.hidden = false;
    if(book.createdAt){
      createdAtLine.hidden = false;
      createdAtLine.textContent = `登録日: ${formatDateForDisplay(book.createdAt)}`;
    }
    updateCoverPreview(book.cover || '');
  }else{
    formTitle.textContent = '本を登録';
    deleteBtn.hidden = true;
    if(mode === 'scan-prefill' && book){
      fieldIsbn.value = book.isbn || '';
    }
  }

  formModal.hidden = false;
}

function closeFormModal(){
  formModal.hidden = true;
}

function updateCoverPreview(url){
  if(url){
    coverPreview.src = url;
    coverPreview.hidden = false;
  }else{
    coverPreview.hidden = true;
    coverPreview.removeAttribute('src');
  }
}

fieldCover.addEventListener('input', () => updateCoverPreview(fieldCover.value.trim()));

coverFileInput.addEventListener('change', () => {
  const file = coverFileInput.files && coverFileInput.files[0];
  if(!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    fieldCover.value = reader.result;
    updateCoverPreview(reader.result);
  };
  reader.readAsDataURL(file);
});

document.getElementById('coverClearBtn').addEventListener('click', () => {
  fieldCover.value = '';
  coverFileInput.value = '';
  updateCoverPreview('');
});

document.getElementById('cancelFormBtn').addEventListener('click', closeFormModal);
document.querySelector('[data-close-form]').addEventListener('click', closeFormModal);

document.getElementById('isbnSearchBtn').addEventListener('click', async () => {
  const isbn = normalizeIsbn(fieldIsbn.value);
  if(!isbn){
    showFormMessage('ISBNを入力してください。');
    return;
  }
  formLoading.hidden = false;
  formMessage.hidden = true;
  const info = await lookupIsbn(isbn);
  formLoading.hidden = true;
  if(info){
    fieldIsbn.value = info.isbn || isbn;
    if(info.title) fieldTitle.value = info.title;
    if(info.author) fieldAuthor.value = info.author;
    if(info.publisher) fieldPublisher.value = info.publisher;
    if(info.pubdate) fieldPubdate.value = info.pubdate;
    if(info.cover){ fieldCover.value = info.cover; updateCoverPreview(info.cover); }
    showFormMessage('書誌情報を取得しました。内容を確認してください。', 'info');
  }else{
    showFormMessage('書誌情報が見つかりませんでした。手入力してください。', 'warn');
  }
  checkDuplicateForIsbn(isbn);
});

function showFormMessage(msg, kind = 'info'){
  formMessage.textContent = msg;
  formMessage.className = kind === 'warn' ? 'notice notice-warn' : 'notice notice-info';
  formMessage.hidden = false;
}

function checkDuplicateForIsbn(isbn){
  dupNotice.hidden = true;
  if(!isbn) return;
  const existing = findByIsbn(isbn);
  if(existing && existing.id !== currentEditId){
    dupNotice.innerHTML = `このISBNは既に登録されています：「${escapeHtml(existing.title || '')}」　`
      + `<button type="button" class="link" id="openExistingBtn">登録済みの内容を開く</button>`;
    dupNotice.hidden = false;
    document.getElementById('openExistingBtn').addEventListener('click', () => {
      openFormModal('edit', existing);
    });
  }
}

fieldIsbn.addEventListener('blur', () => checkDuplicateForIsbn(normalizeIsbn(fieldIsbn.value)));

bookForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = fieldTitle.value.trim();
  if(!title){
    showFormMessage('書名を入力してください。', 'warn');
    return;
  }
  const isbn = normalizeIsbn(fieldIsbn.value);

  if(!currentEditId && isbn){
    const existing = findByIsbn(isbn);
    if(existing){
      const proceed = confirm(`このISBNは既に登録されています：「${existing.title}」\n重複したまま新しく登録しますか？`);
      if(!proceed) return;
    }
  }

  const book = {
    id: currentEditId || genId(),
    isbn,
    title,
    author: fieldAuthor.value.trim(),
    publisher: fieldPublisher.value.trim(),
    pubdate: fieldPubdate.value.trim(),
    cover: fieldCover.value.trim(),
    createdAt: currentCreatedAt || new Date().toISOString()
  };

  await Store.put(book);
  await reload();
  closeFormModal();
  showToast(currentEditId ? '保存しました。' : '登録しました。');
});

deleteBtn.addEventListener('click', async () => {
  if(!currentEditId) return;
  if(!confirm('この本を削除しますか？この操作は取り消せません。')) return;
  await Store.delete(currentEditId);
  await reload();
  closeFormModal();
  showToast('削除しました。');
});

document.getElementById('manualBtn').addEventListener('click', () => openFormModal('new'));

function formatDateForDisplay(iso){
  try{
    const d = new Date(iso);
    if(isNaN(d.getTime())) return iso;
    return d.toLocaleString('ja-JP', { year:'numeric', month:'2-digit', day:'2-digit' });
  }catch(e){ return iso; }
}

/* =========================================================
   Scan modal (camera barcode scanning)
   ========================================================= */
const scanModal = document.getElementById('scanModal');
const scanError = document.getElementById('scanError');
let html5QrCode = null;
let scanning = false;

document.getElementById('scanBtn').addEventListener('click', openScanModal);
document.querySelector('[data-close-scan]').addEventListener('click', closeScanModal);

async function openScanModal(){
  scanError.hidden = true;
  scanModal.hidden = false;

  const hasCamera = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  if(!hasCamera){
    showScanError('お使いの環境ではカメラを利用できません。「手入力で登録」をご利用ください。');
    return;
  }
  if(typeof Html5Qrcode === 'undefined'){
    showScanError('バーコード読み取りライブラリを読み込めませんでした（オフラインの可能性があります）。「手入力で登録」をご利用ください。');
    return;
  }

  try{
    html5QrCode = new Html5Qrcode('scanReader', {
      formatsToSupport: [ Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8 ],
      verbose: false
    });
    const config = { fps: 10, qrbox: { width: 260, height: 140 } };
    await html5QrCode.start({ facingMode: 'environment' }, config, onScanSuccess, () => {});
    scanning = true;
  }catch(e){
    console.error(e);
    showScanError('カメラを起動できませんでした。カメラの利用許可を確認するか、「手入力で登録」をご利用ください。');
  }
}

function showScanError(msg){
  scanError.textContent = msg;
  scanError.hidden = false;
}

async function closeScanModal(){
  await stopScan();
  scanModal.hidden = true;
}

async function stopScan(){
  if(html5QrCode && scanning){
    scanning = false;
    try{ await html5QrCode.stop(); html5QrCode.clear(); }
    catch(e){ /* ignore */ }
  }
}

async function onScanSuccess(decodedText){
  if(!scanning) return;
  await stopScan();
  scanModal.hidden = true;
  await handleScannedCode(decodedText);
}

async function handleScannedCode(rawText){
  const isbn = normalizeIsbn(rawText);
  if(!isLikelyIsbn13(isbn)){
    showToast('ISBNバーコードとして認識できませんでした。内容を確認して手入力してください。');
  }
  openFormModal('scan-prefill', { isbn });
  checkDuplicateForIsbn(isbn);
  formLoading.hidden = false;
  const info = await lookupIsbn(isbn);
  formLoading.hidden = true;
  if(info){
    fieldIsbn.value = info.isbn || isbn;
    fieldTitle.value = info.title || '';
    fieldAuthor.value = info.author || '';
    fieldPublisher.value = info.publisher || '';
    fieldPubdate.value = info.pubdate || '';
    fieldCover.value = info.cover || '';
    updateCoverPreview(info.cover || '');
    showFormMessage('書誌情報を取得しました。内容を確認して保存してください。', 'info');
  }else{
    showFormMessage('書誌情報が見つかりませんでした。手入力してください。', 'warn');
  }
}

/* =========================================================
   Export / Import
   ========================================================= */
function downloadBlob(content, filename, mime){
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function todayStamp(){
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

document.getElementById('exportJsonBtn').addEventListener('click', () => {
  if(books.length === 0){ showToast('エクスポートする本がありません。'); return; }
  downloadBlob(JSON.stringify(books, null, 2), `books_export_${todayStamp()}.json`, 'application/json');
});

const CSV_COLUMNS = ['isbn', 'title', 'author', 'publisher', 'pubdate', 'cover', 'createdAt'];

function toCsvField(v){
  const s = (v === undefined || v === null) ? '' : String(v);
  if(/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

document.getElementById('exportCsvBtn').addEventListener('click', () => {
  if(books.length === 0){ showToast('エクスポートする本がありません。'); return; }
  const lines = [CSV_COLUMNS.join(',')];
  books.forEach(b => {
    lines.push(CSV_COLUMNS.map(col => toCsvField(b[col])).join(','));
  });
  downloadBlob('﻿' + lines.join('\r\n'), `books_export_${todayStamp()}.csv`, 'text/csv');
});

function parseCsv(text){
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for(let i = 0; i < text.length; i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; }
        else inQuotes = false;
      }else field += c;
    }else{
      if(c === '"') inQuotes = true;
      else if(c === ','){ row.push(field); field = ''; }
      else if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ''; }
      else if(c === '\r'){ /* skip, \n handles row end */ }
      else field += c;
    }
  }
  if(field.length > 0 || row.length > 0){ row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1 || (r.length === 1 && r[0] !== ''));
}

document.getElementById('importBtn').addEventListener('click', () => {
  document.getElementById('importFile').click();
});

document.getElementById('importFile').addEventListener('change', async (e) => {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if(!file) return;

  const text = await file.text();
  let records = [];

  try{
    if(file.name.toLowerCase().endsWith('.json')){
      const data = JSON.parse(text);
      records = Array.isArray(data) ? data : [data];
    }else{
      const rows = parseCsv(text);
      if(rows.length > 0){
        const header = rows[0].map(h => h.trim());
        for(let i = 1; i < rows.length; i++){
          const rec = {};
          header.forEach((h, idx) => { rec[h] = rows[i][idx] || ''; });
          records.push(rec);
        }
      }
    }
  }catch(err){
    console.error(err);
    showToast('ファイルの読み込みに失敗しました。形式を確認してください。');
    return;
  }

  let added = 0, skipped = 0;
  for(const rec of records){
    const isbn = normalizeIsbn(rec.isbn);
    const title = (rec.title || '').toString().trim();
    if(!title){ skipped++; continue; }
    if(isbn && findByIsbn(isbn)){ skipped++; continue; }
    const book = {
      id: genId(),
      isbn,
      title,
      author: (rec.author || '').toString().trim(),
      publisher: (rec.publisher || '').toString().trim(),
      pubdate: (rec.pubdate || '').toString().trim(),
      cover: (rec.cover || '').toString().trim(),
      createdAt: rec.createdAt || new Date().toISOString()
    };
    await Store.put(book);
    books.push(book);
    added++;
  }
  await reload();
  showToast(`インポート完了：${added}件追加、${skipped}件スキップしました。`);
});

/* =========================================================
   Init
   ========================================================= */
async function reload(){
  books = await Store.getAll();
  render();
}

reload();
