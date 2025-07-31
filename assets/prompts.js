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
        clinicalScenarioOptional2: `You are a clinical triage assistant. Analyze the following input and determine if it describes a CLINICAL CASE for diagnostic evaluation.

        CLINICAL CASE FOR DIAGNOSIS: IF the input contains a clinical scenario with patient information (symptoms, signs, test results, medical history, etc.) that is being presented for diagnostic evaluation. The user is describing a patient case to understand what conditions might be present.

        Examples of CASES FOR DIAGNOSIS:
        - "My left shoulder has been sore with pain radiating to my arm"
        - "Patient presents with green nail on hallux"
        - "47-year-old male with consistently low BMI"
        - "Itching on penis"
        - "Patient has wrinkles and cream-colored lines around eyes"
        - "Patient reports breathing problems and irregular breathing patterns"

        NOT FOR DIAGNOSIS: IF the input contains clinical information but the user is asking about treatment, management, therapeutic recommendations, medication guidance, or management strategies (even with patient context).

        Examples of NOT FOR DIAGNOSIS:
        - "What treatment should I give for shoulder pain?"
        - "How to manage low BMI in this patient?"
        - "What medication is best for this condition?"

        Return ONLY the word true or false. Do not add any explanation or extra text.

        INPUT:
        {{description}}`,
        clinicalScenarioOptional1: `You are a clinical triage assistant. Analyze the following input and determine if it describes a patient case presented for diagnostic evaluation.

            Return true **IF** the input includes:
            - A description of symptoms, signs, complaints, or clinical findings, **AND**
            - There is a clear or implied intention to understand what condition or diagnosis might be present.

            Return false **IF**:
            - The input is only asking about treatment, medication, or management, without diagnostic interest.
            - The input lacks any patient-related clinical information.

            Return ONLY the word true or false. Do not add any explanation or extra text.

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
