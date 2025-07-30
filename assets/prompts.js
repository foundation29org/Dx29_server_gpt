const PROMPTS = {
    diagnosis: {
        clinicalScenarioCheckold: `You are a clinical triage assistant. Analyze the following input and determine if it describes a clinical scenario or contains relevant clinical information about a patient (such as symptoms, psychological or emotional complaints, laboratory results, imaging findings, medical diagnoses, or any medical observations).

        IF the input contains any clinical scenario, psychological or emotional complaint, laboratory result, imaging report, relevant patient-specific medical information, a list of medical diagnoses, or even a single symptom or medical complaint (including subjective symptoms, informal complaints, or non-technical descriptions), return true.
        ELSE, return false.

        Return ONLY the word true or false. Do not add any explanation or extra text.

        INPUT:
        {{description}}`,
        clinicalScenarioCheck: `You are a clinical triage assistant. Analyze the following input and determine if it describes a CLINICAL CASE for diagnostic evaluation.

        CLINICAL CASE FOR DIAGNOSIS: IF the input contains a clinical scenario with patient information (symptoms, signs, test results, medical history, etc.) that is being presented for diagnostic evaluation. The user is describing a patient case to understand what conditions might be present.

        NOT FOR DIAGNOSIS: IF the input contains clinical information but the user is asking about treatment, management, therapeutic recommendations, medication guidance, or management strategies (even with patient context).

        Return ONLY the word true or false. Do not add any explanation or extra text.

        INPUT:
        {{description}}`,
        medicalQuestionCheck: `You are a medical content classifier. Analyze the following input and determine if it contains a medical question or medical-related content.

        MEDICAL QUESTION: IF the input contains any medical-related question, inquiry about health, disease, treatment, medication, medical procedures, medical knowledge, or any healthcare-related topic. This includes questions about treatment algorithms, therapeutic recommendations, medication guidance, or management strategies, even if they include specific patient context.

        NON-MEDICAL: Everything else that is not related to medicine, health, or healthcare.

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
