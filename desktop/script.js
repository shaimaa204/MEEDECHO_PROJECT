// ---------------------------------------------------------
// GLOBAL CONFIG
// ---------------------------------------------------------
const API_URL = "http://localhost:8001";

const contentArea = document.getElementById("dynamic-content");
const dashboardSection = document.getElementById("content-dashboard");
const navItems = document.querySelectorAll(".nav-item");
const tabItems = document.querySelectorAll(".tab-item");
const allNavElements = [...navItems, ...tabItems];

// Recording state
let mediaRecorder = null;
let recordingStream = null;
let recordedChunks = [];
let recordingTimer = null;
let recordingSeconds = 0;

// "intake" | "final_assessment"
let currentRecordingPhase = "intake";
let currentRecordingOutputId = null;

// Last JSON report returned from backend (used in editor/PDF)
let lastReportJson = null;

// TinyMCE state
let tinyEditorInitialized = false;

// Selected case for Phase 2
let selectedCaseIdForPhase2 = null;


// ---------------------------------------------------------
// UTILS
// ---------------------------------------------------------
function formatTime(sec) {
    const m = String(Math.floor(sec / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    return `${m}:${s}`;
}


// ---------------------------------------------------------
// RECORDING MODAL UI
// ---------------------------------------------------------
function resetRecordingUI() {
    const status = document.getElementById("recording-status");
    const timerEl = document.getElementById("recording-timer");
    const startBtn = document.getElementById("start-record-btn");
    const stopBtn = document.getElementById("stop-record-btn");
    const feedback = document.getElementById("modal-feedback");

    if (!status || !timerEl || !startBtn || !stopBtn) return;

    status.textContent = "Ready to Record";
    timerEl.classList.add("hidden");
    timerEl.textContent = "00:00";

    startBtn.classList.remove("hidden");
    stopBtn.classList.add("hidden");
    stopBtn.disabled = true;

    if (feedback) {
        feedback.classList.add("hidden");
        feedback.textContent = "";
    }

    recordedChunks = [];
    recordingSeconds = 0;

    if (recordingTimer) {
        clearInterval(recordingTimer);
        recordingTimer = null;
    }
}

function openRecordingModal(phase = "intake", outputId = null) {
    currentRecordingPhase = phase;
    currentRecordingOutputId = outputId;

    const modal = document.getElementById("recording-modal");
    if (!modal) {
        console.error("recording-modal not found");
        return;
    }
    resetRecordingUI();
    modal.classList.remove("hidden");
}

function closeRecordingModal() {
    const modal = document.getElementById("recording-modal");
    if (modal) modal.classList.add("hidden");
}


// ---------------------------------------------------------
// RECORDING LOGIC
// ---------------------------------------------------------
async function startRecording() {
    const status = document.getElementById("recording-status");
    const timerEl = document.getElementById("recording-timer");
    const startBtn = document.getElementById("start-record-btn");
    const stopBtn = document.getElementById("stop-record-btn");
    const feedback = document.getElementById("modal-feedback");

    if (!status || !timerEl || !startBtn || !stopBtn) return;

    try {
        recordingStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(recordingStream);

        recordedChunks = [];
        recordingSeconds = 0;

        mediaRecorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) {
                recordedChunks.push(e.data);
            }
        };

        mediaRecorder.onstart = () => {
            status.textContent = "Recording…";
            timerEl.classList.remove("hidden");
            timerEl.textContent = "00:00";

            startBtn.classList.add("hidden");
            stopBtn.classList.remove("hidden");
            stopBtn.disabled = false;

            recordingTimer = setInterval(() => {
                recordingSeconds += 1;
                timerEl.textContent = formatTime(recordingSeconds);
            }, 1000);
        };

        mediaRecorder.onstop = () => {
            if (recordingTimer) {
                clearInterval(recordingTimer);
                recordingTimer = null;
            }

            status.textContent = "Processing audio…";

            const blob = new Blob(recordedChunks, { type: "audio/webm" });

            if (recordingStream) {
                recordingStream.getTracks().forEach(t => t.stop());
                recordingStream = null;
            }

            document.dispatchEvent(new CustomEvent("recording-complete", {
                detail: blob
            }));
        };

        mediaRecorder.start();

    } catch (err) {
        console.error("Error starting recording:", err);
        if (feedback) {
            feedback.textContent = `Error: ${err.message}`;
            feedback.classList.remove("hidden");
        }
    }
}

function stopRecording() {
    const status = document.getElementById("recording-status");
    const stopBtn = document.getElementById("stop-record-btn");

    if (!mediaRecorder || mediaRecorder.state !== "recording") {
        if (status) status.textContent = "Not recording.";
        return;
    }

    if (stopBtn) stopBtn.disabled = true;
    if (status) status.textContent = "Stopping…";
    mediaRecorder.stop();
}


// ---------------------------------------------------------
// WHEN RECORDING FINISHES
// ---------------------------------------------------------
document.addEventListener("recording-complete", (e) => {
    console.log("[script.js] recording-complete received");

    const audioBlob = e.detail;
    let outputEl = null;

    if (currentRecordingOutputId) {
        outputEl = document.getElementById(currentRecordingOutputId);
    }

    if (!outputEl) {
        // Fallback hidden div (for dashboard recording)
        outputEl = document.createElement("div");
        outputEl.style.display = "none";
        document.body.appendChild(outputEl);
    }

    uploadRecordedAudioForPhase(currentRecordingPhase, audioBlob, outputEl);
});


// ---------------------------------------------------------
// UPLOAD AUDIO → BACKEND
// ---------------------------------------------------------
async function uploadRecordedAudioForPhase(phase, audioBlob, outputEl) {
    const kb = (audioBlob.size / 1024).toFixed(1);
    outputEl.innerHTML = `<p class="text-primary">Uploading ${kb} KB for phase: ${phase}…</p>`;

    const fd = new FormData();
    fd.append("file", audioBlob, `recording_${Date.now()}.webm`);

    // 👇 مهم جداً: نرسل case_id عند Phase 2
   if (phase === "final_assessment" && window.selectedCaseIdForPhase2) {
    fd.append("intake_id", window.selectedCaseIdForPhase2);  // <-- FIX
}


    const endpoint = phase === "final_assessment"
    ? `${API_URL}/phase2-transcribe?intake_id=${selectedCaseIdForPhase2}`
    : `${API_URL}/phase1-transcribe`;


    try {
        const res = await fetch(endpoint, {
            method: "POST",
            body: fd,
        });

        if (!res.ok) {
            const errTxt = await res.text();
            throw new Error(`API Error: ${errTxt}`);
        }

        const json = await res.json();
        lastReportJson = json;
// =========================================================
// AUTO CHECKLIST COMPLETION (if Preload.js + Main.js support it)
// =========================================================
if (window.checklistAPI && window.checklistAPI.autoComplete) {
    try {
        await window.checklistAPI.autoComplete();
        console.log("Checklist automatically completed.");
    } catch (err) {
        console.error("Checklist auto-complete failed:", err);
    }
} else {
    console.warn("Checklist API not available.");
}

        outputEl.innerHTML = `
            <pre class="text-xs bg-gray-900 text-green-200 p-3 rounded overflow-auto max-h-80">
${JSON.stringify(json, null, 2)}
            </pre>
        `;

        closeRecordingModal();
        openEditorWithJson(json);
    } catch (err) {
        console.error("Upload failed:", err);
        outputEl.innerHTML = `<p class="text-red-600">Upload failed: ${err.message}</p>`;
        closeRecordingModal();
    }
}



// ---------------------------------------------------------
// TINYMCE EDITOR
// ---------------------------------------------------------
function buildHtmlFromJson(report) {
    if (!report || typeof report !== "object") {
        return "<p>No report data.</p>";
    }

    const safe = (k, fallback = "") => (report && report[k]) || fallback;

    let findingsHtml = "";
    if (Array.isArray(report.detailed_findings) && report.detailed_findings.length > 0) {
        findingsHtml = `
            <h2>Findings</h2>
            <ul>
                ${report.detailed_findings.map(f => `
                    <li><strong>${f.finding || ""}</strong>: ${f.explanation || ""}</li>
                `).join("")}
            </ul>
        `;
    }

    let recHtml = "";
    if (Array.isArray(report.recommendations) && report.recommendations.length > 0) {
        recHtml = `
            <h2>Recommendations</h2>
            <ul>
                ${report.recommendations.map(r => `<li>${r}</li>`).join("")}
            </ul>
        `;
    }

    return `
        <h1>Medical Report (${(safe("phase", "") || "").toUpperCase()})</h1>
        <p><strong>Patient:</strong> ${safe("patient_name", "N/A")}</p>
        <p><strong>Age:</strong> ${safe("age", "N/A")} | <strong>Sex:</strong> ${safe("sex", "N/A")}</p>
        <p><strong>Exam Type:</strong> ${safe("exam_type", "N/A")}</p>
        <p><strong>Exam Date:</strong> ${safe("exam_date", "N/A")}</p>

        <h2>Clinical History</h2>
        <p>${(safe("clinical_history", "") || "").replace(/\n/g, "<br>")}</p>

        ${findingsHtml}

        <h2>Impression</h2>
        <p>${(safe("impression_summary", "") || "").replace(/\n/g, "<br>")}</p>

        ${recHtml}
    `;
}

function ensureTinyMCEInitialized(callback) {
    if (tinyEditorInitialized && window.tinymce && tinymce.get("html-editor")) {
        callback(tinymce.get("html-editor"));
        return;
    }

    if (!window.tinymce) {
        console.error("TinyMCE not loaded.");
        return;
    }

    tinymce.init({
        selector: "#html-editor",
        menubar: false,
        height: 500,
        plugins: "lists link",
        toolbar: "undo redo | bold italic underline | bullist numlist | link",
        setup: (editor) => {
            editor.on("init", () => {
                tinyEditorInitialized = true;
                callback(editor);
            });
        }
    });
}

function openEditorWithJson(reportJson) {
    const modal = document.getElementById("edit-report-modal");
    const feedback = document.getElementById("edit-feedback");
    if (!modal) {
        console.error("edit-report-modal not found");
        return;
    }

    if (feedback) {
        feedback.classList.add("hidden");
        feedback.textContent = "";
    }

    const html = buildHtmlFromJson(reportJson);

    ensureTinyMCEInitialized((editor) => {
        editor.setContent(html);
        modal.classList.remove("hidden");
    });
}


// ---------------------------------------------------------
// PAGE LOADER & NAV
// ---------------------------------------------------------
async function loadPage(pageId) {
    console.log("Loading page:", pageId);

    if (pageId === "dashboard") {
        dashboardSection.classList.remove("hidden");
        contentArea.innerHTML = "";
        return;
    }

    dashboardSection.classList.add("hidden");

    const filePath = `${pageId}.html`;

    try {
        const res = await fetch(filePath);
        if (!res.ok) throw new Error(`Failed to fetch ${filePath}`);

        contentArea.innerHTML = await res.text();

        setTimeout(() => {
            if (pageId === "phase1") initPhase1Page();
            if (pageId === "phase2") initPhase2Page();
            if (pageId === "history") initHistoryPage();
            if (pageId === "patients") initPatientsPage();
        }, 0);

    } catch (err) {
        contentArea.innerHTML = `<p class="text-red-600">Failed to load ${pageId}. ${err.message}</p>`;
        console.error(err);
    }
}

function setActiveLink(pageId) {
    allNavElements.forEach(el => {
        const parentLi = el.closest("li");
        el.classList.remove("text-primary", "font-semibold");
        if (parentLi) parentLi.classList.remove("bg-primary/10");

        if (el.tagName === "A" && !parentLi) {
            el.classList.remove("border-primary");
            el.classList.add("border-transparent", "text-gray-500");
        }
    });

    allNavElements
        .filter(el => el.dataset.page === pageId)
        .forEach(el => {
            el.classList.add("text-primary", "font-semibold");
            const parentLi = el.closest("li");
            if (parentLi) parentLi.classList.add("bg-primary/10");

            if (el.tagName === "A" && !parentLi) {
                el.classList.add("border-primary");
                el.classList.remove("border-transparent", "text-gray-500");
            }
        });
}

function handleNavigationClick(e) {
    e.preventDefault();
    const pageId = e.currentTarget.dataset.page;
    loadPage(pageId);
    setActiveLink(pageId);
}

// ===============================
// PATIENTS PAGE (works with your backend)
// GET /patients returns: [{id,name,age,gender}, ...]
// ===============================

function initPatientsPage() {
  console.log("Patients page loaded.");

  const tbody = document.getElementById("patients-table-body");
  const loadingEl = document.getElementById("patients-loading");
  const emptyEl = document.getElementById("patients-empty-state");
  const errorEl = document.getElementById("patients-error");

  const searchEl = document.getElementById("patients-search");
  const statusEl = document.getElementById("patients-filter-status");      // optional (can ignore)
  const tagEl = document.getElementById("patients-filter-tag");            // optional (can ignore)
  const clinicianEl = document.getElementById("patients-filter-clinician");// optional (can ignore)

  const retryBtn = document.getElementById("patients-retry");

  if (!tbody || !loadingEl || !emptyEl || !errorEl) {
    console.warn("Patients page elements missing. Check IDs in patients.html");
    return;
  }

  const show = ({ loading=false, empty=false, error=false }) => {
    loadingEl.classList.toggle("hidden", !loading);
    emptyEl.classList.toggle("hidden", !empty);
    errorEl.classList.toggle("hidden", !error);
    if (loading || empty || error) tbody.innerHTML = "";
  };

  const escapeHtml = (s) =>
    String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");

  function renderRows(items) {
    tbody.innerHTML = items.map((p) => {
      return `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/20">
          <td class="px-6 py-4">
            <div class="font-semibold text-slate-900 dark:text-white">${escapeHtml(p.name || "-")}</div>
            <div class="text-xs text-slate-500">${escapeHtml(p.id || "")}</div>
          </td>
          <td class="px-6 py-4 text-sm text-slate-700 dark:text-slate-300">${escapeHtml(p.age ?? "-")}</td>
          <td class="px-6 py-4 text-sm text-slate-700 dark:text-slate-300">${escapeHtml(p.gender ?? "-")}</td>
          <td class="px-6 py-4 text-right">
            <button class="px-3 py-2 rounded-lg bg-slate-200 dark:bg-slate-700 hover:bg-slate-300 dark:hover:bg-slate-600
                           text-slate-900 dark:text-white text-sm font-medium"
                    data-action="view" data-id="${escapeHtml(p.id)}">
              View
            </button>
          </td>
        </tr>
      `;
    }).join("");

    tbody.querySelectorAll("button[data-action='view']").forEach(btn => {
      btn.addEventListener("click", () => {
        console.log("View patient:", btn.dataset.id);
      });
    });
  }

  async function loadPatients() {
    show({ loading: true });

    try {
      const res = await fetch(`${API_URL}/patients`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const patients = await res.json(); // <-- array

      // simple client-side search
      const q = (searchEl?.value || "").trim().toLowerCase();
      const filtered = (patients || []).filter(p =>
        !q ||
        (p.name || "").toLowerCase().includes(q) ||
        (p.id || "").toLowerCase().includes(q)
      );

      if (!filtered.length) {
        show({ loading: false, empty: true });
        return;
      }

      show({ loading: false });
      renderRows(filtered);

    } catch (e) {
      console.error("Patients load error:", e);
      show({ loading: false, error: true });
    }
  }

  // debounce search
  const debounce = (fn, ms=300) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  const refresh = debounce(loadPatients, 300);

  searchEl?.addEventListener("input", refresh);

  // (filters are optional; backend doesn't support them now, but keep UI responsive)
  statusEl?.addEventListener("change", refresh);
  tagEl?.addEventListener("input", refresh);
  clinicianEl?.addEventListener("input", refresh);

  retryBtn?.addEventListener("click", loadPatients);
// ===== Add Patient Drawer bindings =====
const drawer   = document.getElementById("add-patient-drawer");
const panel    = document.getElementById("add-patient-panel");
const overlay  = document.getElementById("add-patient-overlay");

const openBtn  = document.getElementById("open-add-patient"); // زر اللي فوق
const closeBtn = document.getElementById("close-add-patient");
const cancelBtn= document.getElementById("cancel-add-patient");

const form = document.getElementById("add-patient-form");
const fb   = document.getElementById("add-patient-feedback");

function openDrawer() {
  if (!drawer || !panel) return;
  drawer.classList.remove("hidden");
  requestAnimationFrame(() => panel.classList.remove("translate-x-full"));
}
function closeDrawer() {
  if (!drawer || !panel) return;
  panel.classList.add("translate-x-full");
  setTimeout(() => drawer.classList.add("hidden"), 250);
}

openBtn?.addEventListener("click", openDrawer);
closeBtn?.addEventListener("click", closeDrawer);
cancelBtn?.addEventListener("click", closeDrawer);
overlay?.addEventListener("click", closeDrawer);

form?.addEventListener("submit", async (e) => {
  e.preventDefault();
  fb?.classList.add("hidden");

  const payload = {
    id: document.getElementById("patient-id").value.trim(),
    name: document.getElementById("patient-name").value.trim(),
    age: Number(document.getElementById("patient-age").value),
    gender: document.getElementById("patient-sex").value
  };

  try {
    const res = await fetch(`${API_URL}/patients`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to add patient");

    fb?.classList.remove("hidden");
    form.reset();

    await loadPatients();   // ✅ نفس الدالة داخل initPatientsPage
    closeDrawer();

  } catch (err) {
    alert("❌ " + err.message);
  }
});

  loadPatients();
}


// ---------------------------------------------------------
// PHASE 1 INIT
// ---------------------------------------------------------
async function initPhase1Page() {
    console.log("Phase 1 ready");

    // نحاول نلاقي زر التسجيل داخل الـ dynamic-content فقط
    const recordBtn =
        document.querySelector("#dynamic-content #start-phase1-record") ||
        document.querySelector("#dynamic-content #record-session-btn-phase1") ||
        document.querySelector("#dynamic-content #record-session-btn");

    const uploadBtn = document.getElementById("upload-btn");
    const audioInput = document.getElementById("audioInput");
    const outputEl = document.getElementById("phase1-output");

    if (recordBtn) {
        recordBtn.onclick = () => {
            openRecordingModal("intake", "phase1-output");
        };
    }

    if (uploadBtn && audioInput && outputEl) {
        uploadBtn.onclick = async () => {
            if (!audioInput.files.length) {
                outputEl.innerHTML = `<p class="text-red-600">Select an audio file first!</p>`;
                return;
            }
            const audioFile = audioInput.files[0];
            uploadRecordedAudioForPhase("intake", audioFile, outputEl);
        };
    }

    await loadPhase1Table();
}


// ---------------------------------------------------------
// LOAD PHASE 1 TABLE
// ---------------------------------------------------------
async function loadPhase1Table() {
    const tbody = document.querySelector("#phase1-table tbody");
    if (!tbody) return;

    tbody.innerHTML = `
        <tr>
            <td colspan="3" class="p-2 text-center">
                Loading cases...
            </td>
        </tr>
    `;

    try {
        const res = await fetch(`${API_URL}/phase1-cases`);
        const data = await res.json();

        if (!data || data.length === 0) {
            tbody.innerHTML = `
                <tr>
                    <td colspan="3" class="p-2 text-center">
                        No cases found.
                    </td>
                </tr>
            `;
            return;
        }

        tbody.innerHTML = ""; // clear loading

        data.forEach(row => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td class="p-2 border-b">${row.case_id}</td>
                <td class="p-2 border-b">${row.patient || "N/A"}</td>
                <td class="p-2 border-b">
                    <button
                        class="text-blue-600 underline open-phase2-btn"
                        data-case="${row.case_id}">
                        Intake ready
                    </button>
                </td>
            `;
            tbody.appendChild(tr);
        });

        document.querySelectorAll(".open-phase2-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const caseId = btn.dataset.case;
                console.log("Opening Phase 2 for case:", caseId);

                selectedCaseIdForPhase2 = caseId;

                loadPage("phase2");
                setActiveLink("phase2");
            });
        });

    } catch (err) {
        console.error("Failed to load cases:", err);
        tbody.innerHTML = `
            <tr>
                <td colspan="3" class="p-2 text-center text-red-600">
                    Failed to load cases: ${err.message}
                </td>
            </tr>
        `;
    }
}

// =====================================================
// INIT PHASE 2 PAGE (Dynamic)
// =====================================================
function initPhase2Page() {
    console.log("Phase 2 ready");

    const infoBanner = document.getElementById("phase2-case-info");

    // Check case from Phase 1
    if (!selectedCaseIdForPhase2) {
        infoBanner.textContent =
            "No intake case selected. Please go to Phase 1 and click 'Intake ready' for a case.";
        return;
    }

    infoBanner.textContent =
        `Loaded intake case: ${selectedCaseIdForPhase2}. Now record the final doctor assessment.`;

    // Bind the record button AFTER the HTML is loaded
    attachPhase2RecordButton();
}

// =====================================================
// PHASE 2 RECORD BUTTON BINDER
// =====================================================
function attachPhase2RecordButton() {
    const btn = document.getElementById("start-phase2-record");

    if (!btn) {
        console.error("❌ Phase 2 record button NOT FOUND! (HTML didn't load)");
        return;
    }

    btn.addEventListener("click", () => {
        console.log("🎤 Phase 2 recording started");
        openRecordingModal("final_assessment", "phase2-output");
    });

    console.log("✅ Phase 2 record button attached.");
}


// ---------------------------------------------------------
// HISTORY PAGE
// ---------------------------------------------------------
async function initHistoryPage() {
    console.log("History page loaded.");

    const tableBody = document.getElementById("history-table-body");
    if (!tableBody) {
        console.error("History table body not found!");
        return;
    }

    tableBody.innerHTML = `
        <tr><td class="px-6 py-4">Loading...</td></tr>
    `;

    try {
        const res = await fetch(`${API_URL}/list-reports`);
        const data = await res.json();

        tableBody.innerHTML = "";

        if (!data.length) {
            tableBody.innerHTML = `
                <tr><td class="px-6 py-4 text-gray-500">No reports found.</td></tr>
            `;
            return;
        }

        data.forEach(item => {
            const row = `
                <tr>
                    <td class="px-6 py-4">${item.patient}</td>
                    <td class="px-6 py-4">${item.reportId}</td>
                    <td class="px-6 py-4">${new Date(item.date).toLocaleString()}</td>
                    <td class="px-6 py-4">${item.phase}</td>
                    <td class="px-6 py-4 text-right">
                        <a href="${item.downloadUrl}"
                           class="text-primary hover:underline"
                           target="_blank">Download</a>
                    </td>
                </tr>
            `;
            tableBody.insertAdjacentHTML("beforeend", row);
        });

    } catch (err) {
        tableBody.innerHTML = `
            <tr><td class="px-6 py-4 text-red-600">
                Failed to load history: ${err.message}
            </td></tr>
        `;
    }
}

// ---------------------------------------------------------
// MAIN INIT
// ---------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    // Nav
    allNavElements.forEach(el =>
        el.addEventListener("click", handleNavigationClick)
    );

    // Dashboard record button (الكرت الأزرق في الـ Dashboard)
    const dashboardRecord = document.getElementById("record-session-btn");
    if (dashboardRecord) {
        dashboardRecord.onclick = () => {
            openRecordingModal("intake", null); // no direct output element
        };
    }

    // Recording modal buttons
    const startBtn = document.getElementById("start-record-btn");
    const stopBtn = document.getElementById("stop-record-btn");
    const closeModalBtn = document.getElementById("close-recording-modal");

    if (startBtn) startBtn.onclick = startRecording;
    if (stopBtn) stopBtn.onclick = stopRecording;
    if (closeModalBtn) closeModalBtn.onclick = closeRecordingModal;

    // Editor modal buttons / form
    const editForm = document.getElementById("edit-report-form");
    const cancelEdit = document.getElementById("cancel-edit-modal");
    const editModal = document.getElementById("edit-report-modal");
    const editFeedback = document.getElementById("edit-feedback");

    if (cancelEdit && editModal) {
        cancelEdit.onclick = () => {
            editModal.classList.add("hidden");
        };
    }

    if (editForm) {
        editForm.onsubmit = async (e) => {
            e.preventDefault();

            if (!lastReportJson) {
                if (editFeedback) {
                    editFeedback.textContent = "No report data to save.";
                    editFeedback.classList.remove("hidden");
                }
                return;
            }

            let htmlContent = "";
            if (window.tinymce && tinymce.get("html-editor")) {
                htmlContent = tinymce.get("html-editor").getContent();
            }

            try {
                const res = await fetch(`${API_URL}/generate-pdf`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        report_json: lastReportJson,
                        edited_html: htmlContent
                    })
                });

                if (!res.ok) {
                    const errTxt = await res.text();
                    throw new Error(errTxt);
                }

                const blob = await res.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                const fileName = (lastReportJson.report_id || "report") + "_final.pdf";
                a.download = fileName;
                a.click();
                window.URL.revokeObjectURL(url);

                if (editFeedback) {
                    editFeedback.textContent = "✅ PDF generated and downloaded.";
                    editFeedback.classList.remove("hidden");
                }

            } catch (err) {
                console.error("PDF generation error:", err);
                if (editFeedback) {
                    editFeedback.textContent = `Error: ${err.message}`;
                    editFeedback.classList.remove("hidden");
                }
            }
        };
    }
// ===== Dashboard bindings =====
const dashStart = document.getElementById("dashboard-start-recording");
dashStart?.addEventListener("click", () => openRecordingModal("intake", null));

// Hotkey: press R to start recording (avoid typing inside inputs)
document.addEventListener("keydown", (e) => {
  if (e.key.toLowerCase() !== "r") return;
  const tag = (e.target?.tagName || "").toLowerCase();
  if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
  openRecordingModal("intake", null);
});

// Open patients/history from dashboard tiles
document.getElementById("dashboard-open-patients")?.addEventListener("click", () => {
  loadPage("patients");
  setActiveLink("patients");
});
document.getElementById("dashboard-open-history")?.addEventListener("click", () => {
  loadPage("history");
  setActiveLink("history");
});

// Load dashboard data (counts + last session)
async function initDashboardFancy() {
  try {
    // patients count
    const pres = await fetch(`${API_URL}/patients`);
    const patients = pres.ok ? await pres.json() : [];
    const activeCount = Array.isArray(patients) ? patients.length : 0;

    // reports count + last session
    const rres = await fetch(`${API_URL}/list-reports`);
    const reports = rres.ok ? await rres.json() : [];
    const completedCount = Array.isArray(reports) ? reports.length : 0;

    // pending: your backend doesn't have "pending" yet, so placeholder (0)
    const pendingCount = 0;

    // fill stats
    document.getElementById("stat-active").textContent = activeCount;
    document.getElementById("stat-completed").textContent = completedCount;
    document.getElementById("stat-pending").textContent = pendingCount;

    document.getElementById("tile-active").textContent = activeCount;
    document.getElementById("tile-completed").textContent = completedCount;

    // last session snapshot (latest report)
    const last = Array.isArray(reports) && reports.length ? reports[0] : null;
    document.getElementById("last-patient").textContent = last?.patient || "—";
    document.getElementById("last-phase").textContent = last?.phase || "—";
    document.getElementById("last-time").textContent = last?.date ? new Date(last.date).toLocaleString() : "—";

    // context bar
    const context = last
      ? `Patient: ${last.patient} | Phase: ${last.phase} | Status: Completed`
      : `Patient: — | Phase: — | Status: —`;
    document.getElementById("dashboard-context").textContent = context;

    // timeline strip (make it look fancy)
    const timeline = document.getElementById("dashboard-timeline");
    if (timeline) {
      if (!reports?.length) {
        timeline.innerHTML = `<div class="text-sm text-slate-500 dark:text-slate-400">No activity yet.</div>`;
      } else {
        const top = reports.slice(0, 6);
        timeline.innerHTML = top.map(r => {
          const t = r.date ? new Date(r.date).toLocaleString() : "—";
          return `
            <div class="flex items-center justify-between gap-4 px-4 py-3 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
              <div class="min-w-0">
                <p class="text-sm font-semibold text-slate-900 dark:text-white truncate">${r.patient || "Unknown"} — ${r.phase || "report"}</p>
                <p class="text-xs text-slate-500 dark:text-slate-400 truncate">${r.reportId || ""}</p>
              </div>
              <div class="text-xs font-semibold text-slate-500 dark:text-slate-400 whitespace-nowrap">${t}</div>
            </div>
          `;
        }).join("");
      }
    }

    // resume button: go to history for now
    document.getElementById("dashboard-resume")?.addEventListener("click", () => {
      loadPage("history");
      setActiveLink("history");
    });

  } catch (e) {
    console.error("Dashboard init failed:", e);
  }
}

initDashboardFancy();

    // Default page
    loadPage("dashboard");
    setActiveLink("dashboard");
});
