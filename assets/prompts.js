const PROMPTS = {
    diagnosis: {
        clinicalScenarioCheckold: `You are a clinical triage assistant. Analyze the following input and determine if it describes a clinical scenario or contains relevant clinical information about a patient (such as symptoms, psychological or emotional complaints, laboratory results, imaging findings, medical diagnoses, or any medical observations).

        IF the input contains any clinical scenario, psychological or emotional complaint, laboratory result, imaging report, relevant patient-specific medical information, a list of medical diagnoses, or even a single symptom or medical complaint (including subjective symptoms, informal complaints, or non-technical descriptions), return true.
        ELSE, return false.

        Return ONLY the word true or false. Do not add any explanation or extra text.

        INPUT:
        {{description}}`,
        clinicalScenarioCheck: `You are a clinical-triage assistant.  
            Your task is to decide whether the user is describing a SPECIFIC PATIENT CASE **for diagnostic purposes**.

            Return ONLY the word **true** or **false** (lower-case, no extra text).

            Return **true** when the message …
            • presents symptoms, signs, test- or imaging-results, medical history, or other patient-specific data,  
            • refers to an identifiable patient (real or self) – even briefly ("itching on penis", "pail finger nails"),  
            • contains laboratory findings, test results, or clinical data that need interpretation, or
            • the intent is to know **what condition(s) could be causing it** (differential diagnosis or "what is this?"), or
            • presents abnormal clinical findings (even if asymptomatic) that require medical evaluation, or
            • describes symptoms or clinical manifestations that need diagnostic evaluation, or
            • contains a list of diagnoses/conditions that appear to be describing a specific patient case, or
            • mentions multiple conditions that suggest a complex patient scenario requiring diagnostic analysis
            • contains imaging findings or radiological reports that need interpretation

            Return **false** when the message …
            • asks mainly about treatment, management, drugs, follow-up, or prognosis for a known condition,  
            • is a general theoretical question, a definition, or just the name of a disease/test ("Síndrome del cabello anágeno corto"),  
            • concerns lab techniques, guidelines, or population data without describing a concrete patient,  
            • is administrative / non-clinical, or
            • asks specific questions about why a particular finding is elevated/abnormal (e.g., "Why is ferritin so high?"), or
            • is clearly a general medical question without patient context

            **PRIORITY RULES**:
            • If the message asks about treatment/management for a known condition, return **false** regardless of patient context
            • If the message contains patient data but the primary intent is treatment advice, return **false**
            • When in doubt about diagnostic vs. treatment intent, return **true** only if the focus is on understanding the underlying condition
            • If the message contains multiple diagnoses/conditions that could represent a patient case, return **true**
            • If the message appears to be describing a patient's condition profile, return **true**

            **Examples**

            true  
            - "Male, 23 y. Since age 14 right-sided stabbing headache, tearing eye…"  
            - "Paciente 65 a con ansiedad y abuso de benzodiacepinas, pérdida de peso…"  
            - "Black tongue in a 45-year-old woman."  
            - "I have stomach pain"
            - "Itching on penis"
            - "Swelling on feet"
            - "Patient with headache and nausea"
            - "Low ferritin, high iron, high absorption rate"
            - "Patient with elevated liver enzymes and bilirubin"
            - "High TSH, low T4, patient feels tired"
            - "Low white count. B12 deficiency. Copper deficiency. Iron deficiency"
            - "Female, age 25, b.p. 12080, resting pulse 30. Asymptomatic"
            - "Patient with elevated blood pressure but no symptoms"
            - "Abnormal ECG findings in asymptomatic patient"

            false  
            - "¿Cómo tratar la diabetes tipo 2?»  
            - "¿Es patológico aislar Staphylococcus aureus sensible en una herida?"  
            - "Síndrome del cabello anágeno corto."  
            - "Dosis de paracetamol en niños de 20 kg."  
            - "Woman 60 years old with high ferritin... Why is ferritin so high?"
            - "Patient with elevated liver enzymes... What causes this?"

            INPUT:  
            {{description}}`,
        medicalQuestionCheck: `You are a medical content classifier. Analyze the following input and determine if it contains a medical question or medical-related content.

        MEDICAL QUESTION: IF the input contains any medical-related question, inquiry about health, disease, treatment, medication, medical procedures, medical knowledge, or any healthcare-related topic that can be answered with general medical knowledge.

        NON-MEDICAL: IF the input requests analysis, summary, or evaluation of specific patient data without providing that data (e.g., "resumen de esta paciente", "analiza los síntomas de este paciente" without patient information).

        Return ONLY one of these two words:
        - "medical" if it's a medical question or medical-related content
        - "non-medical" if it's not related to medicine or healthcare

        Do not add any explanation or extra text.

        INPUT:
        {{description}}`,
        withoutDiseases: `You are a diagnostic assistant. Given the patient case below, generate N possible diagnoses. For each:- Give a brief description of the disease- List symptoms the patient has that match the disease- List patient symptoms that are not typical for the disease
        Output format:
        Return a JSON array of N objects, each with the following keys:- "diagnosis": disease name- "description": brief summary of the disease- "symptoms_in_common": list of matching symptoms- "symptoms_not_in_common": list of patient symptoms not typical of that disease
        Output only valid JSON (no extra text, no XML, no formatting wrappers).
        Example:
        [
        {{
        "diagnosis": "Disease A",
        "description": "Short explanation.",
        "symptoms_in_common": ["sx1", "sx2"],
        "symptoms_not_in_common": ["sx3", "sx4"]
        }},
        ...
        ]
        PATIENT DESCRIPTION:
        {{description}}`,
        withDiseases: `You are a diagnostic assistant. Given the patient case below, generate N more possible diagnoses. For each:- Give a brief description of the disease- List symptoms the patient has that match the disease- List patient symptoms that are not typical for the disease
        Output format:
        Return a JSON array of N objects, each with the following keys:- "diagnosis": disease name- "description": brief summary of the disease- "symptoms_in_common": list of matching symptoms- "symptoms_not_in_common": list of patient symptoms not typical of that disease
        Output only valid JSON (no extra text, no XML, no formatting wrappers).
        Example:
        [
        {{
        "diagnosis": "Disease A",
        "description": "Short explanation.",
        "symptoms_in_common": ["sx1", "sx2"],
        "symptoms_not_in_common": ["sx3", "sx4"]
        }},
        ...
        ]
        PATIENT DESCRIPTION:
        {{description}}

        ALREADY SUGGESTED DIAGNOSES (EXCLUDE THESE)
        {{previous_diagnoses}}
        `,
    },
    version: '1.0.1'
};

module.exports = PROMPTS;
