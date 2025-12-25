# transcription.py
import os
import json
from datetime import datetime
from openai import OpenAI
from viocetoreportapp.json_to_pdf import make_pdf_from_case
from lkl.lkl_manager import LKLManager


# -----------------------------
# OpenAI client initialization
# -----------------------------
api_key = os.environ.get("OPENAI_API_KEY")
if not api_key:
    raise ValueError("OPENAI_API_KEY is missing. Please set it in your environment.")
client = OpenAI(api_key=api_key)

MEMORY_FILE = "memory.json"

TARGET_SCHEMA_JSON = """{
  "report_id": "string",
  "phase": "intake | final_assessment",
  "patient_name": "string",
  "age": "string",
  "sex": "string",
  "dob": "string",
  "referring_doctor": "string",
  "exam_date": "string",
  "exam_type": "string",
  "clinical_history": "string",
  "detailed_findings": [{"finding":"string","explanation":"string"}],
  "impression_summary": "string",
  "recommendations": ["string"],
  "urgency_level": "low | moderate | high | N/A"
}"""

# -----------------------------
# Memory load/save
# -----------------------------
if os.path.exists(MEMORY_FILE):
    with open(MEMORY_FILE, "r", encoding="utf-8") as f:
        memory = json.load(f)
else:
    memory = {"cases": [], "final_reports": []}


def _save_memory():
    with open(MEMORY_FILE, "w", encoding="utf-8") as f:
        json.dump(memory, f, indent=2, ensure_ascii=False)


def _safe_parse_llm_response(resp):
    """Return dict from OpenAI response, even if it’s a raw string."""
    try:
        content = resp.choices[0].message.content
    except Exception:
        return {"error": "LLM returned no content"}

    if isinstance(content, dict):
        return content

    try:
        return json.loads(content)
    except Exception:
        return {"raw_output": str(content)}


def _get_intake_case(case_id: str):
    """
    Look up an intake case by report_id from memory["cases"].
    Returns dict or {} if not found.
    """
    if not case_id:
        return {}

    for c in memory.get("cases", []):
        if c.get("report_id") == case_id:
            return c
    return {}


# =====================================================================
# FULL PIPELINE
# =====================================================================
def process_full_medical_report(
    audio_file_path: str,
    phase: str,
    intake_case_id: str | None = None,
):
    """
    Phase 1 (intake):
        audio -> Whisper -> LKL -> LLM(JSON) -> auto-learn -> save as intake case

    Phase 2 (final_assessment):
        intake JSON + doctor final audio -> LKL -> LLM(JSON) -> auto-learn -> save final report
    """

    lkl = LKLManager()  # uses lkl/lkl.json by default
    filename = os.path.basename(audio_file_path)
    case_id_from_file = filename.split(".")[0]

    print(f"\n🎙 Processing PHASE={phase} → file={filename}")

    # --------------------------------------------------------
    # STEP 1 — TRANSCRIBE AUDIO (common to both phases)
    # --------------------------------------------------------
    try:
        with open(audio_file_path, "rb") as audio_file:
            transcription = client.audio.transcriptions.create(
                model="whisper-1",
                file=audio_file,
                response_format="verbose_json",
            )
        transcript_text = getattr(transcription, "text", "").strip()
        print("✅ Whisper transcription complete.")
    except Exception as e:
        print(f"🛑 Transcription failed: {e}")
        return {"error": "Transcription failed."}

    # --------------------------------------------------------
    # PHASE 1: INTAKE PIPELINE
    # --------------------------------------------------------
    if phase == "intake":
        category = lkl.detect_category(transcript_text)
        missing_info = (
            lkl.detect_missing_info(category, transcript_text) if category else []
        )
        knowledge = lkl.get_category_knowledge(category)

        prompt =   f"""
you are a highly specialized Medical AI Assistant acting as a Doctor-Level Report Extractor and Formatter for the INITIAL CLINICAL INTAKE (Phase 1.

    Your task is to analyze a raw transcript of a doctor’s voice recording or medical dictation,Regardless of the language used in TRANSCRIPT, you must interpret it accurately and produce the entire JSON report exclusively in English.
 and convert it into a structured JSON report that mirrors the clarity and structure of a professional hospital report for the INITIAL CLINICAL INTAKE.

TRANSCRIPT:
{transcript_text}

LKL CATEGORY: {category}
LKL KNOWLEDGE:
{json.dumps(knowledge, indent=2)}

LKL MISSING INFO HINTS:
{json.dumps(missing_info, indent=2)}


    ### Core Objective:
    Produce a structured JSON that captures every single relevant medical detail — including symptoms, timing, tone, body part, progression, cause, related systems, and physician reasoning.  
    Do not summarize or simplify — the report will be read by medical professionals.

### Strict Rules:
    1. Do not fabricate or omit any detail.  
       Reword only for clarity, but every medical element in the transcript must appear in the report.

    2. Follow this exact JSON schema:
    {TARGET_SCHEMA_JSON}

    3. If any field is missing or not mentioned, use `"N/A"` or an empty list `[]`.

    4. The report must be in English.

    5. Keep the writing professional, precise, and clinical.  
       No speculation, no conversational tone.

    6. In "clinical_history", extract and structure the patient’s history following the complete clinical history framework used in hospital documentation and OSCE standards:

    The history must be comprehensive and cover the following components whenever available:

    Patient Profile: name, age, sex, occupation, marital status, and any demographic identifiers.
    
    Chief Complaint (CC): the patient’s main concern or symptom, written in their words and with duration (e.g., “low back pain for 2 months”). Avoid medical jargon if transcript uses patient phrasing.

    History of Present Illness (HPI): detailed evolution and analysis of the complaint using the SOCRATES framework (Site, Onset, Character, Radiation, Associated symptoms, Timing, Exacerbating/relieving factors, Severity).

    Systemic Enquiry / Review of Systems (ROS): capture any other symptoms mentioned that belong to cardiovascular, respiratory, gastrointestinal, genitourinary, musculoskeletal, neurological, endocrine, or general systems.

    Past Medical and Surgical History: chronic diseases, prior hospitalizations, operations, and relevant medical conditions.

    Drug History: prescribed medications, dosage, adherence, allergies, and adverse reactions.

    Family History: hereditary or familial illnesses, consanguinity, and similar conditions in relatives.   

    Social History: lifestyle, occupation, smoking/alcohol/drug use, living situation, travel, and physical activity.

    Functional/Physiotherapy Relevance: mobility limitations, daily living impact, assistive device use, or physical restriction patterns.

    7. In "detailed_findings", extract every distinct clinical observation, measurement, or physician remark mentioned in the transcript — do not limit the number of findings.

Your goal is to capture all explicit or implicit medical findings the doctor states or implies, even if they seem minor or repetitive.

Rules:

Include all findings.

Every symptom, observation, exam result, test interpretation, or relevant measurement must appear as a separate "finding".

Even subtle or secondary details (e.g., “mild wheeze,” “tenderness on palpation,” “normal reflexes,” “no cyanosis”) must be captured — normal and abnormal alike.

Do not merge or summarize.
Each statement in the audio that describes a distinct feature should produce a distinct JSON object.

Use precise medical language.
Keep all entries clinical and standardized — no conversational tone.

Use system labeling.
Assign each finding to the appropriate system (e.g., “musculoskeletal,” “respiratory,” “neurological,” “cardiovascular,” “gastrointestinal,” “endocrine,” “general”).

Explain significance.
"explanation" should state the possible cause, mechanism, or clinical relevance of the finding — as a clinician would interpret it.

Severity & timing.
Include "severity" and "temporal_relation" when available (e.g., “moderate,” “acute,” “chronic,” “progressive”). Use "N/A" if not mentioned.

Order findings logically.
Present them grouped by system, in the same sequence as the transcript whenever possible.
    8. "impression_summary" must deliver a professional-level clinical synthesis — a concise diagnostic reasoning paragraph similar to what a senior physician or physiotherapist would write in a hospital note.

It should:

Integrate key information from the "clinical_history" and "detailed_findings".

Identify the most likely diagnosis or clinical impression, supported by reasoning.

Mention relevant differential diagnoses when uncertainty exists.

Comment on disease stage, chronicity, or functional impact if described.

Use formal hospital language — e.g., “Findings are consistent with…”, “The overall picture suggests…”, “Differential considerations include…”

The tone must be concise, authoritative, and objective, written as if for inclusion in a real patient chart.

    9. `"recommendations"` should list specific next steps, including tests, referrals, or management advice — explained briefly.

    10. `"urgency_level"` must reflect the seriousness based on described symptoms:  
       - “low” for mild or routine findings  
       - “moderate” for concerning but stable conditions  
       - “high” for severe, acute, or urgent cases

    ---

    Style Guide:
    - Use formal medical report style (e.g., “Examination revealed...”, “Patient reports...”).
    - Keep sentences clear, concise, and objective.
    - Avoid layman explanations.
    - Each section should read like a real internal hospital report.
    - No bullet points or markdown — output pure JSON.
    -only use only english 

    ---

    Input Transcript:
    The following text is a raw transcript from a doctor’s spoken notes.  
    It may include pauses, repetition, or filler words — interpret them correctly and extract all possible clinical information.

    TRANSCRIPT:
{transcript_text}

    Now, analyze it thoroughly and output only the structured JSON report following the schema above.
    No explanations, no formatting, no comments — only valid JSON.
    """



        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0.0,
            max_tokens=4000,
        )

        report = _safe_parse_llm_response(response)

        # Metadata
        report["report_id"] = case_id_from_file
        report["phase"] = "intake"
        report["timestamp"] = datetime.now().isoformat()
        report["_category"] = category
        report["_missing_info"] = missing_info

        # 🔵 LKL AUTO-LEARNING FROM INTAKE
        if category:
            print(f"📚 LKL auto-learn (Phase 1) for category: {category}")
            lkl.auto_learn_from_report(category, report)

        # Save for Phase 2
        memory["cases"].append(report)
        _save_memory()

        print(f"💾 Saved intake report: {case_id_from_file}")
        return report

    # --------------------------------------------------------
    # PHASE 2: FINAL ASSESSMENT PIPELINE
    # --------------------------------------------------------
    elif phase == "final_assessment":
        # 1) Load intake case
        intake_case = _get_intake_case(intake_case_id)

        if not intake_case:
            msg = f"Intake case not found for ID: {intake_case_id}"
            print(f"🛑 FATAL: {msg}")
            return {"error": msg}

        print(f"✅ Loaded intake case for Phase 2: {intake_case_id}")

        # 2) Build combined text for LKL (intake history + final transcript)
        intake_history = intake_case.get("clinical_history", "") or ""
        combined_for_category = intake_history + "\n\n" + transcript_text

        category = lkl.detect_category(combined_for_category) or intake_case.get(
            "_category"
        )
        missing_info = (
            lkl.detect_missing_info(category, combined_for_category) if category else []
        )
        knowledge = lkl.get_category_knowledge(category)

        # 3) Prompt: synthesize intake JSON + final dictation
        prompt = f"""
You are a highly specialized Medical AI Assistant acting as a Doctor-Level Report Synthesizer and Formatter for the FINAL CLINICAL ASSESSMENT (Phase 2).

Your job is to generate a comprehensive, structured FINAL ASSESSMENT report by combining:
1) The structured INTAKE report from Phase 1 (Initial History & Symptoms).
2) The FINAL DOCTOR DICTATION (Phase 2 transcript), which contains updated findings, diagnostic interpretation, and the definitive plan.

INTAKE REPORT (Phase 1 JSON - Structured History):
{json.dumps(intake_case, indent=2)}

DOCTOR FINAL DICTATION (Phase 2 transcript - Clinical Interpretation & Plan):
{transcript_text}

LKL CATEGORY: {category}
LKL KNOWLEDGE:
{json.dumps(knowledge, indent=2)}

LKL MISSING INFO HINTS:
{json.dumps(missing_info, indent=2)}

### Core Objective:
Produce a structured FINAL ASSESSMENT JSON that:
- Reflects the COMPLETE and FINAL clinical picture at this stage.
- Integrates the initial Phase 1 intake data with all new information from Phase 2.
- Ensures that EVERY medically relevant statement from the FINAL DOCTOR DICTATION is explicitly represented somewhere in the report (clinical_history, detailed_findings, impression_summary, or recommendations).
- Uses precise, professional, hospital-style language in English only.

### Integration Logic:
- The Phase 1 INTAKE report provides the baseline history and initial findings.
- The FINAL DOCTOR DICTATION (Phase 2) MUST OVERRIDE or REFINE any conflicting information or impressions from Phase 1.
- If Phase 2 indicates improvement, worsening, resolution, or new symptoms/findings, this evolution MUST be clearly reflected.
- You must NOT delete or ignore relevant Phase 1 information unless Phase 2 explicitly contradicts or supersedes it; in that case, the final version should reflect the most up-to-date state while acknowledging evolution where appropriate.

### Strict Rules:
1. Do not fabricate or omit any detail.
   - Every medically relevant element from the FINAL DOCTOR DICTATION MUST appear in the final report.
   - Reword only for clarity and clinical style, but do NOT drop or merge away distinct pieces of information.

2. Follow this exact JSON schema:
{TARGET_SCHEMA_JSON}

3. If any field is missing or not mentioned in both Phase 1 and Phase 2, use "N/A" or an empty list [].

4. Language:
   - The report must be in English.
   - Regardless of the language used in the INTAKE REPORT or DOCTOR FINAL DICTATION, you must interpret them accurately and produce the entire JSON report exclusively in English, without mixing languages.

5. Style:
   - Keep the writing professional, precise, and clinical.
   - No speculation beyond what is clinically reasonable and supported.
   - No conversational tone, no explanations outside of the JSON, no markdown.

### clinical_history Construction:
"clinical_history" must represent the FINAL, integrated clinical history following hospital documentation and OSCE standards, updated with Phase 2 information.

It should cover, whenever available:

- Patient Profile:
  - Name, age, sex, occupation, marital status, and any demographic identifiers.
  - If incomplete in Phase 1, attempt to complete from Phase 2 if explicitly mentioned.

- Chief Complaint / Current Main Issue:
  - The patient’s main concern at this stage, in their words if provided, with duration or evolution since initial presentation.
  - Example: "Low back pain, now improved over 6 weeks" or "New onset dyspnea for 3 days."

- History of Present Illness / Interval Course:
  - Use SOCRATES where applicable:
    Site, Onset, Character, Radiation, Associated symptoms, Timing, Exacerbating/relieving factors, Severity.
  - Clearly distinguish:
    • Symptoms that have resolved,
    • Symptoms that have improved,
    • Symptoms that are unchanged,
    • New symptoms or complications described in Phase 2.
  - Explicitly reflect temporal evolution relative to Phase 1 (e.g., "previously severe, now mild and intermittent").

- Systemic Enquiry / Review of Systems (ROS):
  - Capture all mentioned symptoms or explicit negatives in:
    cardiovascular, respiratory, gastrointestinal, genitourinary, musculoskeletal, neurological, endocrine, hematologic, psychiatric, and general systems.
  - Both positive and clearly stated negative findings must be included (e.g., “no chest pain,” “no new neurological deficits”).

- Past Medical and Surgical History:
  - Include all chronic diseases, prior hospitalizations, operations, and relevant conditions.
  - Add any NEW conditions or diagnoses mentioned in Phase 2.

- Drug History:
  - Current medications, dosing, and adherence when mentioned.
  - Changes since Phase 1: started, stopped, or adjusted treatments.
  - Allergies and adverse reactions.

- Family History:
  - Hereditary or familial illnesses, similar conditions in relatives, and consanguinity if mentioned or updated.

- Social History:
  - Lifestyle, occupation and work status (including return-to-work or restrictions).
  - Smoking, alcohol, or drug use.
  - Living situation, support systems, travel, and physical activity relevant to the condition.

- Functional / Physiotherapy Relevance:
  - Current functional status compared to baseline (better, worse, stable).
  - Limitations in activities of daily living (ADLs) and instrumental ADLs.
  - Assistive devices (cane, walker, orthosis, etc.).
  - Work capacity, sports, and physical activity limitations.
  - Any functional outcome metrics mentioned (e.g., walking distance, time standing, stair tolerance).

### detailed_findings Construction:
"detailed_findings" must list EVERY distinct clinical observation, measurement, investigation result, or physician remark from Phase 1 and Phase 2, with emphasis on the FINAL interpretation from Phase 2.

Rules:

- Include ALL findings:
  - Each symptom description, physical exam finding, lab result, imaging interpretation, functional assessment, and relevant normal/abnormal observation.
  - Every distinct statement from the FINAL DOCTOR DICTATION that carries medical information must correspond to at least one "finding" object.

- Do NOT merge or summarize:
  - Each distinct feature = one separate JSON object in "detailed_findings".
  - If the doctor mentions similar things at different times or with different severity (e.g., "was severe, now mild"), represent these temporal changes explicitly (either as separate findings or clearly captured via temporal_relation/explanation).

- Include normal and abnormal findings:
  - For example: "normal reflexes", "no cyanosis", "no new focal deficit", "normal chest X-ray", “no evidence of fracture”, etc., must all appear.

- Use precise medical language:
  - Use standardized clinical terminology (supported by LKL Knowledge) without lay phrasing.

- System labeling:
  - Assign each finding to one of the appropriate systems, such as:
    "musculoskeletal", "respiratory", "neurological", "cardiovascular",
    "gastrointestinal", "genitourinary", "endocrine", "hematologic",
    "psychiatric", "general", "investigations/labs", "imaging", "functional".
  
- Explanation:
  - "explanation" should state the possible cause, mechanism, interpretation, or clinical relevance of the finding, as a clinician would.
  - When applicable, include its relevance to diagnosis, prognosis, or treatment response.

- Severity & timing:
  - Use "severity" to indicate intensity when provided or clearly implied (e.g., "mild", "moderate", "severe").
  - Use "temporal_relation" to reflect timing and evolution (e.g., "acute", "subacute", "chronic", "improved", "worsened", "stable", "resolved", "new-onset").
  - Use "N/A" if not mentioned.

- Comparison to baseline:
  - When Phase 2 compares current status to baseline (Phase 1), represent this explicitly in "temporal_relation" and/or "explanation" (e.g., "pain intensity reduced compared to initial assessment").

- Order:
  - Group findings logically by system and, where possible, follow the sequence of the FINAL DOCTOR DICTATION.

### impression_summary Construction:
"impression_summary" must be a professional-level FINAL clinical synthesis similar to a senior physician’s final assessment or discharge note.

It should:
- Integrate key elements from "clinical_history" and "detailed_findings".
- Clearly state the primary diagnosis or diagnoses and whether they are:
  - confirmed, probable, or suspected.
- Mention relevant differential diagnoses when uncertainty exists.
- Comment on:
  - Disease stage (acute, subacute, chronic).
  - Current activity (active, stable, improving, deteriorating, in remission).
  - Response to treatment so far.
  - Functional impact and level of disability, if described.
- Use formal hospital language, such as:
  - “Findings are consistent with…”
  - “The overall picture suggests…”
  - “Differential considerations include…”
  - “There is significant clinical and functional improvement following…”

### recommendations Construction:
"recommendations" must list clear, specific, and actionable next steps based on the FINAL assessment:

- Management and treatment:
  - Ongoing medications, new prescriptions, dose changes, tapering, or discontinuation.
  - Rehabilitation or exercise plans.
  - Lifestyle or work modifications.

- Investigations:
  - Further tests or imaging if still indicated.
  - Monitoring parameters.

- Referrals:
  - To specialists, physiotherapy, occupational therapy, psychology, pain clinic, etc., as mentioned.

- Safety and red flags:
  - Any documented safety advice or red-flag symptoms that should trigger urgent review.

- Follow-up:
  - Suggested follow-up interval and purpose, if stated (e.g., “review in 6 weeks to reassess pain and function”).

Each recommendation should be explicit and justified in clinical terms when possible.

### urgency_level:
"urgency_level" must reflect the seriousness of the FINAL clinical state:

- "low" for stable, routine follow-up or chronic conditions without red flags.
- "moderate" for concerning but stable conditions that need timely, but not emergent, review.
- "high" for severe, acute, unstable situations, red-flag symptoms, or need for urgent intervention.

### Output Rules:
- Use only English language in the output.
- Output ONLY a single valid JSON object that strictly follows {TARGET_SCHEMA_JSON}.
- Do NOT include explanations, comments, or markdown outside the JSON.
- Every medically relevant piece of information present in the FINAL DOCTOR DICTATION must be represented somewhere in the JSON (history, findings, impression, or recommendations).
- If something is not mentioned in either input and cannot be safely inferred, use "N/A" or [].

Now, analyze the INTAKE REPORT and the DOCTOR FINAL DICTATION thoroughly and generate the FINAL ASSESSMENT report strictly as a single JSON object in English.
"""


        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0.0,
        )

        report = _safe_parse_llm_response(response)

        # Metadata
        report["report_id"] = intake_case_id or case_id_from_file
        report["phase"] = "final_assessment"
        report["timestamp"] = datetime.now().isoformat()
        report["_category"] = category
        report["_missing_info"] = missing_info
        report["_intake_report_id"] = intake_case_id

        # 🔵 LKL AUTO-LEARNING FROM FINAL REPORT
        if category:
            print(f"📚 LKL auto-learn (Phase 2) for category: {category}")
            lkl.auto_learn_from_report(category, report)

        # Save final report
        memory.setdefault("final_reports", []).append(report)
        _save_memory()

        print(f"💾 Saved FINAL report for intake={intake_case_id}")
        return report

    else:
        raise ValueError(f"Unknown phase: {phase}")


# =====================================================================
# PDF wrapper
# =====================================================================
def make_pdf_from_report(report_json):


    """
    Wrapper used by backend_api to generate a PDF from a report JSON.
    """
    output_path = f"reports/{report_json['report_id']}_final.pdf"
    make_pdf_from_case(report_json, output_path)
    return output_path
