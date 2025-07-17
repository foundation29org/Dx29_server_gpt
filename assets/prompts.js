const PROMPTS = {
    diagnosis: {
        namesOnly: `You are an expert clinician. Based on the patient description below, list the 5 most likely diseases or syndromes, ordered from most to least likely.

        • Carefully analyze the patient’s description and consider all plausible conditions that fit the presentation, including common, uncommon, and ultra-rare disorders if relevant.  
        • Do not exclude treatable metabolic/nutritional or structural causes if they match the case.  
        • Important: Return only a valid JSON array of strings with the disease names—no additional text, explanations, or bullet points. Example: ["Disease A","Disease B","Disease C","Disease D","Disease E"]

        IF input includes a clinical scenario (i.e., patient-specific features like symptoms, onset, progression) — not just medical terms — THEN run diagnostic analysis; ELSE return []

        PATIENT DESCRIPTION
        {{description}}`,
        namesOnlyExcludingPrevious: `You are an expert clinician. Based on the following patient description, list the 5 additional diseases or syndromes most likely (that are NOT already in the provided list), ordered from most to least likely.

        • Carefully analyze the patient's description and consider all plausible conditions that fit the presentation, including common, uncommon, and ultra-rare disorders if relevant.  
        • Do not exclude treatable metabolic/nutritional or structural causes if they match the case.  
        • Important: Return only a valid JSON array of strings with the disease names—no additional text, explanations, or bullet points. Example: ["Disease A","Disease B","Disease C","Disease D","Disease E"]

        IF input includes a clinical scenario (i.e., patient-specific features like symptoms, onset, progression) — not just medical terms — THEN run diagnostic analysis; ELSE return []

        PATIENT DESCRIPTION
        {{description}}

        ALREADY SUGGESTED DIAGNOSES (EXCLUDE THESE)
        {{previous_diagnoses}}`,
        detailsForMultipleDiagnoses: `You are an expert clinician. For each of the following diseases and the patient description, return a JSON array with objects containing:
        - "diagnosis": disease name
        - "description": one-sentence summary of the disease
        - "symptoms_in_common": array of patient symptoms that match the disease
        - "symptoms_not_in_common": array of patient symptoms the patient has that are atypical for the disease

        PATIENT DESCRIPTION
        {{description}}

        DIAGNOSES TO ANALYZE
        {{diagnoses}}

        Return only the JSON array with objects, one for each diagnosis. Use double quotes for all keys and strings.`
    },
    version: '1.0.1'
};

module.exports = PROMPTS;
