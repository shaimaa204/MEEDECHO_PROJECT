import os
import json
from fastapi import FastAPI, UploadFile, File, Body, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import List
import uvicorn

from transcription import (
    process_full_medical_report,
    make_pdf_from_report,
    MEMORY_FILE
)

# =========================================
# APP INIT
# =========================================
app = FastAPI(title="MedEcho Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "audio_files"
REPORTS_DIR = "reports"
PATIENTS_FILE = "patients.json"

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(REPORTS_DIR, exist_ok=True)

if not os.path.exists(PATIENTS_FILE):
    with open(PATIENTS_FILE, "w", encoding="utf-8") as f:
        json.dump([], f)

# =========================================
# PATIENT MODEL
# =========================================
class Patient(BaseModel):
    id: str
    name: str
    age: int
    gender: str

# =========================================
# ADD PATIENT
# =========================================
@app.post("/patients")
def add_patient(patient: Patient):
    with open(PATIENTS_FILE, "r", encoding="utf-8") as f:
        patients = json.load(f)

    for p in patients:
        if p["id"] == patient.id:
            raise HTTPException(status_code=400, detail="Patient ID already exists")

    patients.append(patient.dict())

    with open(PATIENTS_FILE, "w", encoding="utf-8") as f:
        json.dump(patients, f, indent=2)

    return {
        "message": "Patient added successfully",
        "patient": patient
    }

# =========================================
# GET ALL PATIENTS
# =========================================
@app.get("/patients")
def get_patients():
    with open(PATIENTS_FILE, "r", encoding="utf-8") as f:
        return json.load(f)

# =========================================
# PHASE 1 — Intake
# =========================================
@app.post("/phase1-transcribe")
async def phase1_transcribe(file: UploadFile = File(...)):
    filepath = os.path.join(UPLOAD_DIR, file.filename)
    with open(filepath, "wb") as f:
        f.write(await file.read())

    report = process_full_medical_report(filepath, phase="intake")
    return JSONResponse(report)

# =========================================
# PHASE 2 — Final Assessment
# =========================================
@app.post("/phase2-transcribe")
async def phase2_transcribe(
    file: UploadFile = File(...),
    intake_id: str = None
):
    filepath = os.path.join(UPLOAD_DIR, file.filename)
    with open(filepath, "wb") as f:
        f.write(await file.read())

    report = process_full_medical_report(
        filepath,
        phase="final_assessment",
        intake_case_id=intake_id
    )
    return JSONResponse(report)

# =========================================
# PHASE 1 CASE LIST
# =========================================
@app.get("/phase1-cases")
async def phase1_cases():
    if not os.path.exists(MEMORY_FILE):
        return []

    with open(MEMORY_FILE, "r", encoding="utf-8") as f:
        memory = json.load(f)

    cases = memory.get("cases", [])
    result = []

    for c in cases:
        result.append({
            "case_id": c.get("report_id"),
            "patient": c.get("patient_name", "Unknown"),
            "phase": c.get("phase", "intake")
        })

    return result

# =========================================
# GENERATE FINAL PDF
# =========================================
@app.post("/generate-pdf")
async def generate_pdf(report: dict = Body(...)):
    report_json = report.get("report_json")

    if not report_json:
        raise HTTPException(status_code=400, detail="report_json missing")

    pdf_path = make_pdf_from_report(report_json)
    filename = os.path.basename(pdf_path)

    return FileResponse(
        pdf_path,
        filename=filename,
        media_type="application/pdf"
    )

# =========================================
# LIST REPORTS
# =========================================
@app.get("/list-reports")
def list_reports():
    try:
        with open(MEMORY_FILE, "r", encoding="utf-8") as f:
            memory_data = json.load(f)

        final_reports = memory_data.get("final_reports", [])
        report_list = []

        for r in final_reports:
            report_id = r.get("report_id")
            pdf_name = f"{report_id}_final.pdf"
            pdf_path = os.path.join(REPORTS_DIR, pdf_name)

            if os.path.exists(pdf_path):
                report_list.append({
                    "reportId": report_id,
                    "patient": r.get("patient_name", "Unknown"),
                    "phase": r.get("phase", "N/A"),
                    "date": r.get("timestamp", "N/A"),
                    "downloadUrl": f"http://localhost:8001/reports/{pdf_name}"
                })

        return JSONResponse(report_list)

    except Exception as e:
        print("❌ ERROR:", e)
        raise HTTPException(status_code=500, detail="Failed to list reports")

# =========================================
# DOWNLOAD REPORT
# =========================================
@app.get("/reports/{filename}")
def download_report(filename: str):
    file_path = os.path.join(REPORTS_DIR, filename)

    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Report not found")

    return FileResponse(
        file_path,
        media_type="application/pdf",
        filename=filename
    )

# =========================================
# RUN SERVER
# =========================================

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("backend_api:app", host="127.0.0.1", port=8001, reload=False)
