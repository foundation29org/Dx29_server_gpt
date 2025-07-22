const PROMPTS = {
    diagnosis: {
        clinicalScenarioCheck: `You are a clinical triage assistant. Analyze the following input and determine if it describes a clinical scenario (i.e., includes patient-specific features such as symptoms, onset, progression, or evolution), not just a list of medical terms or disease names.

        IF the input contains a clinical scenario, return true.
        ELSE, return false.

        Return ONLY the word true or false. Do not add any explanation or extra text.

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
