const CHANNEL = 'arsheefna-file-viewer';
const PDF_MIME = 'application/pdf';
const IMAGE_MIMES = new Set(['image/png', 'image/jpeg']);
const MAX_PREVIEW_PIXELS = 16000000;
const MAX_PRINT_PIXELS = 16000000;
const elements = Object.fromEntries([
  'file-title', 'page-controls', 'previous-page', 'next-page', 'page-number', 'page-count',
  'zoom-out', 'zoom-in', 'zoom-value', 'fit-page', 'viewer-stage', 'viewer-status',
  'preview-surface', 'preview-canvas', 'preview-image', 'print-pages'
].map(id => [id, document.getElementById(id)]));
const numberLabel = new Intl.NumberFormat('ar-IQ', { maximumFractionDigits: 0 });
let activeDocument = null;
let resizeFrame = 0;
let pdfModulePromise;

function notify(action, details = {}) {
  parent.postMessage({ channel: CHANNEL, action, ...details }, location.origin);
}

function isCurrent(doc) {
  return activeDocument === doc && !doc.disposed;
}

function setStatus(message, error = false) {
  elements['viewer-status'].textContent = message;
  elements['viewer-status'].classList.toggle('is-error', error);
  elements['viewer-status'].hidden = !message;
}

function errorMessage(error) {
  if (error?.name === 'PasswordException') return 'ملف PDF محمي بكلمة مرور. نزّله وافتحه ببرنامج يدعم إدخال كلمة المرور.';
  if (error?.name === 'InvalidPDFException') return 'ملف PDF غير صالح أو تالف. جرّب تنزيله والتحقق من الملف الأصلي.';
  if (error?.name === 'MissingPDFException') return 'تعذر العثور على محتوى ملف PDF.';
  return 'تعذر عرض الملف داخل البرنامج. تگدر تنزّله وتفتحه من الجهاز. تأكد أيضاً من تحديث المتصفح.';
}

function reportError(doc, error) {
  if (!isCurrent(doc)) return;
  doc.failed = true;
  const message = errorMessage(error);
  setStatus(message, true);
  updateControls(doc);
  notify('error', { id: doc.id, message });
}

function updateControls(doc) {
  const usable = isCurrent(doc) && doc.loaded && !doc.failed && !doc.printing;
  const isPdf = doc.mime === PDF_MIME;
  elements['page-controls'].hidden = !isPdf;
  elements['previous-page'].disabled = !usable || doc.pageNumber <= 1;
  elements['next-page'].disabled = !usable || doc.pageNumber >= doc.pageCount;
  elements['page-number'].disabled = !usable;
  elements['page-number'].value = String(doc.pageNumber);
  elements['page-number'].max = String(doc.pageCount);
  elements['page-count'].textContent = numberLabel.format(doc.pageCount);
  elements['zoom-in'].disabled = !usable || doc.currentScale >= 5;
  elements['zoom-out'].disabled = !usable || doc.currentScale <= 0.1;
  elements['fit-page'].disabled = !usable;
  elements['zoom-value'].textContent = doc.currentScale ? `${Math.round(doc.currentScale * 100)}%` : '—';
}

function announceLoaded(doc) {
  if (!isCurrent(doc)) return;
  setStatus('');
  elements['preview-surface'].hidden = false;
  if (!doc.loaded) {
    doc.loaded = true;
    notify('loaded', { id: doc.id, pageCount: doc.pageCount });
  }
  updateControls(doc);
}

function clearPrintPages(doc) {
  if (doc.afterPrint) {
    window.removeEventListener('afterprint', doc.afterPrint);
    doc.afterPrint = null;
  }
  for (const node of doc.printNodes) node.remove();
  doc.printNodes.length = 0;
  for (const url of doc.printUrls) URL.revokeObjectURL(url);
  doc.printUrls.length = 0;
}

function disposeDocument() {
  const doc = activeDocument;
  if (!doc) return Promise.resolve();
  activeDocument = null;
  doc.disposed = true;
  doc.renderVersion += 1;
  const pending = [];
  if (doc.renderTask) {
    doc.renderTask.cancel();
    pending.push(doc.renderTask.promise);
    doc.renderTask = null;
  }
  if (doc.loadingTask) pending.push(doc.loadingTask.destroy());
  else if (doc.pdf) pending.push(doc.pdf.destroy());
  if (doc.imageUrl) URL.revokeObjectURL(doc.imageUrl);
  clearPrintPages(doc);
  elements['preview-image'].removeAttribute('src');
  elements['preview-image'].hidden = true;
  elements['preview-canvas'].hidden = true;
  elements['preview-surface'].hidden = true;
  updateControls(doc);
  return Promise.allSettled(pending).then(() => {
    if (!activeDocument) {
      elements['preview-canvas'].width = 1;
      elements['preview-canvas'].height = 1;
    }
  });
}

function availableSize() {
  const stage = elements['viewer-stage'];
  const padding = window.innerWidth <= 520 ? 20 : 32;
  return {
    width: Math.max(100, (stage.clientWidth || window.innerWidth || 800) - padding),
    height: Math.max(100, (stage.clientHeight || window.innerHeight || 600) - padding)
  };
}

function fitScale(width, height) {
  const available = availableSize();
  return Math.max(0.01, Math.min(available.width / width, available.height / height));
}

async function renderPdfPage(doc) {
  if (!isCurrent(doc) || !doc.pdf || doc.printing) return;
  const version = ++doc.renderVersion;
  const previous = doc.renderTask;
  if (previous) {
    previous.cancel();
    await previous.promise.catch(() => {});
  }
  if (!isCurrent(doc) || version !== doc.renderVersion) return;
  let task;
  try {
    const page = await doc.pdf.getPage(doc.pageNumber);
    if (!isCurrent(doc) || version !== doc.renderVersion) return;
    const original = page.getViewport({ scale: 1 });
    const scale = doc.zoom ?? fitScale(original.width, original.height);
    const viewport = page.getViewport({ scale });
    const outputScale = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(MAX_PREVIEW_PIXELS / (viewport.width * viewport.height)));
    const canvas = elements['preview-canvas'];
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    canvas.setAttribute('aria-label', `${doc.title} — صفحة ${numberLabel.format(doc.pageNumber)} من ${numberLabel.format(doc.pageCount)}`);
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas is unavailable');
    task = page.render({ canvasContext: context, viewport, transform: [outputScale, 0, 0, outputScale, 0, 0], background: '#ffffff' });
    doc.renderTask = task;
    await task.promise;
    if (!isCurrent(doc) || version !== doc.renderVersion) return;
    doc.currentScale = scale;
    canvas.hidden = false;
    elements['preview-image'].hidden = true;
    announceLoaded(doc);
  } catch (error) {
    if (isCurrent(doc) && version === doc.renderVersion && error?.name !== 'RenderingCancelledException') reportError(doc, error);
  } finally {
    if (doc.renderTask === task) doc.renderTask = null;
  }
}

function renderImage(doc) {
  if (!isCurrent(doc) || !doc.imageReady || doc.printing) return;
  const image = elements['preview-image'];
  doc.currentScale = doc.zoom ?? fitScale(image.naturalWidth, image.naturalHeight);
  image.style.width = `${image.naturalWidth * doc.currentScale}px`;
  image.style.height = `${image.naturalHeight * doc.currentScale}px`;
  image.hidden = false;
  elements['preview-canvas'].hidden = true;
  announceLoaded(doc);
}

function renderCurrent(doc) {
  if (!isCurrent(doc) || doc.failed || doc.printing) return;
  if (doc.mime === PDF_MIME) void renderPdfPage(doc);
  else renderImage(doc);
}

function waitForImage(image) {
  if (image.complete && image.naturalWidth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      image.removeEventListener('load', loaded);
      image.removeEventListener('error', failed);
    };
    const loaded = () => { cleanup(); resolve(); };
    const failed = () => { cleanup(); reject(new Error('Image decoding failed')); };
    image.addEventListener('load', loaded, { once: true });
    image.addEventListener('error', failed, { once: true });
    // decode() also resolves cached images whose load event ran before listeners.
    if (typeof image.decode === 'function') image.decode().then(loaded, () => {
      if (image.complete) failed();
    });
  });
}

async function openDocument(message) {
  const previousCleanup = disposeDocument();
  const doc = {
    id: message.id, title: typeof message.title === 'string' ? message.title.slice(0, 1000) : 'معاينة الملف',
    mime: message.mime, pageNumber: 1, pageCount: 1, zoom: null, currentScale: 0,
    loaded: false, failed: false, printing: false, disposed: false, imageReady: false,
    loadingTask: null, pdf: null, imageUrl: null, renderTask: null, renderVersion: 0,
    printUrls: [], printNodes: [], afterPrint: null
  };
  activeDocument = doc;
  document.title = `${doc.title} — أرشيفنا`;
  elements['file-title'].textContent = doc.title;
  elements['file-title'].title = doc.title;
  setStatus('جارٍ تحميل المعاينة…');
  updateControls(doc);
  try {
    if (!(message.bytes instanceof ArrayBuffer) || message.bytes.byteLength === 0 || (doc.mime !== PDF_MIME && !IMAGE_MIMES.has(doc.mime))) throw new Error('Unsupported file data');
    await previousCleanup;
    if (!isCurrent(doc)) return;
    if (doc.mime === PDF_MIME) {
      pdfModulePromise ||= import('/ocr/pdf-legacy.mjs');
      const pdfjs = await pdfModulePromise;
      if (!isCurrent(doc)) return;
      pdfjs.GlobalWorkerOptions.workerSrc = '/ocr/pdf.worker-legacy.mjs';
      doc.loadingTask = pdfjs.getDocument({
        data: new Uint8Array(message.bytes), useSystemFonts: true, isEvalSupported: false,
        cMapUrl: '/ocr/cmaps/', cMapPacked: true,
        standardFontDataUrl: '/ocr/standard_fonts/', wasmUrl: '/ocr/wasm/'
      });
      doc.pdf = await doc.loadingTask.promise;
      if (!isCurrent(doc)) return;
      doc.pageCount = doc.pdf.numPages;
      updateControls(doc);
      await renderPdfPage(doc);
    } else {
      const image = elements['preview-image'];
      doc.imageUrl = URL.createObjectURL(new Blob([message.bytes], { type: doc.mime }));
      image.alt = doc.title;
      image.src = doc.imageUrl;
      await waitForImage(image);
      if (!isCurrent(doc)) return;
      doc.imageReady = true;
      renderImage(doc);
    }
  } catch (error) {
    reportError(doc, error);
  }
}

function changePage(value) {
  const doc = activeDocument;
  if (!doc || !doc.loaded || doc.printing || doc.failed || doc.mime !== PDF_MIME) return;
  const page = Math.min(doc.pageCount, Math.max(1, Math.round(Number(value) || doc.pageNumber)));
  if (page !== doc.pageNumber) {
    doc.pageNumber = page;
    elements['viewer-stage'].scrollTop = 0;
    elements['viewer-stage'].scrollLeft = 0;
    updateControls(doc);
    renderCurrent(doc);
  } else elements['page-number'].value = String(page);
}

function zoomBy(multiplier) {
  const doc = activeDocument;
  if (!doc || !doc.loaded || doc.printing || doc.failed) return;
  doc.zoom = Math.min(5, Math.max(0.1, doc.currentScale * multiplier));
  renderCurrent(doc);
}

function jpegBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Print image conversion failed')), 'image/jpeg', 0.94);
  });
}

async function addPrintImage(doc, url, pageNumber) {
  if (!isCurrent(doc)) return;
  const figure = document.createElement('figure');
  figure.className = 'print-page';
  const image = document.createElement('img');
  image.alt = `${doc.title} — صفحة ${numberLabel.format(pageNumber)}`;
  image.src = url;
  figure.append(image);
  doc.printNodes.push(figure);
  elements['print-pages'].append(figure);
  await waitForImage(image);
}

async function printDocument(doc, requestId) {
  if (!doc.loaded || doc.failed || doc.printing) {
    notify('print-error', { id: doc.id, requestId, message: doc.printing ? 'جارٍ تجهيز الطباعة. انتظر اكتمالها.' : 'انتظر اكتمال معاينة الملف قبل الطباعة.' });
    return;
  }
  doc.printing = true;
  clearPrintPages(doc);
  updateControls(doc);
  let temporaryCanvas;
  let invokedPrint = false;
  try {
    if (doc.renderTask) {
      doc.renderVersion += 1;
      const task = doc.renderTask;
      task.cancel();
      await task.promise.catch(() => {});
      if (doc.renderTask === task) doc.renderTask = null;
    }
    if (!isCurrent(doc)) return;
    if (doc.mime === PDF_MIME) {
      for (let pageNumber = 1; pageNumber <= doc.pageCount; pageNumber += 1) {
        if (!isCurrent(doc)) return;
        setStatus(`جارٍ تجهيز الطباعة — صفحة ${numberLabel.format(pageNumber)} من ${numberLabel.format(doc.pageCount)}…`);
        const page = await doc.pdf.getPage(pageNumber);
        if (!isCurrent(doc)) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(150 / 72, Math.sqrt(MAX_PRINT_PIXELS / (base.width * base.height)));
        const viewport = page.getViewport({ scale });
        temporaryCanvas = document.createElement('canvas');
        temporaryCanvas.width = Math.max(1, Math.floor(viewport.width));
        temporaryCanvas.height = Math.max(1, Math.floor(viewport.height));
        const context = temporaryCanvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas is unavailable');
        const task = page.render({ canvasContext: context, viewport, background: '#ffffff' });
        doc.renderTask = task;
        await task.promise;
        if (doc.renderTask === task) doc.renderTask = null;
        if (!isCurrent(doc)) return;
        const blob = await jpegBlob(temporaryCanvas);
        temporaryCanvas.width = 1;
        temporaryCanvas.height = 1;
        temporaryCanvas = null;
        if (!isCurrent(doc)) return;
        const url = URL.createObjectURL(blob);
        doc.printUrls.push(url);
        await addPrintImage(doc, url, pageNumber);
        if (!isCurrent(doc)) return;
      }
    } else {
      setStatus('جارٍ تجهيز الطباعة…');
      await addPrintImage(doc, doc.imageUrl, 1);
    }
    if (!isCurrent(doc)) return;
    // Retain raster pages until the browser has finished using its print layout.
    doc.afterPrint = () => clearPrintPages(doc);
    window.addEventListener('afterprint', doc.afterPrint, { once: true });
    setStatus('');
    window.focus();
    window.print();
    invokedPrint = true;
    if (isCurrent(doc)) notify('printed', { id: doc.id, requestId });
  } catch (error) {
    if (isCurrent(doc)) {
      setStatus('');
      notify('print-error', { id: doc.id, requestId, message: 'تعذر تجهيز طباعة الملف. جرّب مرة ثانية أو نزّله واطبعه من الجهاز.' });
    }
  } finally {
    if (temporaryCanvas) { temporaryCanvas.width = 1; temporaryCanvas.height = 1; }
    if (!invokedPrint) clearPrintPages(doc);
    doc.printing = false;
    if (isCurrent(doc)) updateControls(doc);
  }
}

elements['previous-page'].addEventListener('click', () => changePage(activeDocument?.pageNumber - 1));
elements['next-page'].addEventListener('click', () => changePage(activeDocument?.pageNumber + 1));
elements['page-number'].addEventListener('change', event => changePage(event.target.value));
elements['page-number'].addEventListener('keydown', event => {
  if (event.key === 'Enter') { event.preventDefault(); changePage(event.target.value); }
});
elements['zoom-out'].addEventListener('click', () => zoomBy(1 / 1.25));
elements['zoom-in'].addEventListener('click', () => zoomBy(1.25));
elements['fit-page'].addEventListener('click', () => {
  const doc = activeDocument;
  if (doc && doc.loaded && !doc.printing && !doc.failed) { doc.zoom = null; renderCurrent(doc); }
});
elements['viewer-stage'].addEventListener('keydown', event => {
  const doc = activeDocument;
  if (!doc || event.ctrlKey || event.altKey || event.metaKey || event.target.tagName === 'INPUT') return;
  const destinations = { PageDown: doc.pageNumber + 1, PageUp: doc.pageNumber - 1, Home: 1, End: doc.pageCount };
  if (Object.hasOwn(destinations, event.key)) { event.preventDefault(); changePage(destinations[event.key]); }
});
const resizeObserver = new ResizeObserver(() => {
  cancelAnimationFrame(resizeFrame);
  resizeFrame = requestAnimationFrame(() => {
    const doc = activeDocument;
    if (doc && doc.zoom === null) renderCurrent(doc);
  });
});
resizeObserver.observe(elements['viewer-stage']);

window.addEventListener('message', event => {
  if (event.source !== parent || event.origin !== location.origin) return;
  const message = event.data;
  if (!message || message.channel !== CHANNEL || typeof message.id !== 'string' || !message.id || message.id.length > 200) return;
  if (message.action === 'open') { void openDocument(message); return; }
  const doc = activeDocument;
  if (!doc || message.id !== doc.id) return;
  if (message.action === 'dispose') { void disposeDocument(); return; }
  if (message.action === 'print' && (typeof message.requestId === 'string' || typeof message.requestId === 'number')) void printDocument(doc, message.requestId);
});
window.addEventListener('pagehide', () => {
  resizeObserver.disconnect();
  cancelAnimationFrame(resizeFrame);
  void disposeDocument();
});
notify('ready');
