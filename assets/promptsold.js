const PROMPTS = {
    diagnosis: {
        withoutDiseases: `You are an expert clinician generating a differential diagnosis.

        TASK  
        Return 5 candidate diagnoses in a valid JSON array.

        For each diagnosis object include these keys:  
        - "diagnosis": disease name  
        - "description": one-sentence summary of the disease  
        - "symptoms_in_common": array of patient symptoms that match the disease  
        - "symptoms_not_in_common": array of patient symptoms the patient has that are atypical for the disease  

        OUTPUT RULES  
        • Output only the JSON array—no XML, Markdown, or extra text.  
        • Use double quotes for all keys and strings.  
        • List diagnoses in order from most to least likely.  
        • Keep language concise and clinically precise.

        PATIENT DESCRIPTION  
        {{description}}`,
        withoutDiseases2: `Behave like a hypothetical doctor tasked with providing N hypothesis diagnosis for a patient based on their description. Your goal is to generate a list of N potential diseases, each with a short description, and indicate which symptoms the patient has in common with the proposed disease and which symptoms the patient does not have in common.

        Carefully analyze the patient description and consider various potential diseases that could match the symptoms described. For each potential disease:
        1. Provide a brief description of the disease
        2. List the symptoms that the patient has in common with the disease
        3. List the symptoms that the patient has that are not in common with the disease
        
        Present your findings in a JSON format within XML tags. The JSON should contain the following keys for each of the N potential disease:
        - "diagnosis": The name of the potential disease
        - "description": A brief description of the disease
        - "symptoms_in_common": An array of symptoms the patient has that match the disease
        - "symptoms_not_in_common": An array of symptoms the patient has that are not in common with the disease
        
        Here's an example of how your output should be structured:
        
        <diagnosis_output>
        [
        {
            "diagnosis": "some disease 1",
            "description": "some description",
            "symptoms_in_common": ["symptom1", "symptom2", "symptomN"],
            "symptoms_not_in_common": ["symptom1", "symptom2", "symptomN"]
        },
        ...
        {
            "diagnosis": "some disease n",
            "description": "some description",
            "symptoms_in_common": ["symptom1", "symptom2", "symptomN"],
            "symptoms_not_in_common": ["symptom1", "symptom2", "symptomN"]
        }
        ]
        </diagnosis_output>
        
        Present your final output within <diagnosis_output> tags as shown in the example above.
        
        Here is the patient description:
        <patient_description>
        {{description}}
        </patient_description>`,
        withDiseases: `You are an expert clinician refining a differential diagnosis.

        TASK  
        Generate EXACTLY 5 new candidate diagnoses that are not already present in the list of previously suggested diseases.  
        Return the result as a single valid JSON array. For each diagnosis object include:

        - "diagnosis": disease name  
        - "description": one-sentence summary of the disease  
        - "symptoms_in_common": array of patient symptoms that match the disease  
        - "symptoms_not_in_common": array of patient symptoms that are atypical or absent for the disease  

        RULES  
        • Exclude any diagnosis (or obvious synonym/subtype) found in the provided diseases_list.  
        • Output only the JSON array—no XML, Markdown, or extra text.  
        • Use double quotes for all keys and strings.  
        • List diagnoses in order from most to least likely.  
        • Keep language concise and clinically precise.

        PATIENT DESCRIPTION  
        {{description}}

        ALREADY SUGGESTED DIAGNOSES  
        {{diseases_list}}`,
        withDiseases2: `Behave like a hypothetical doctor tasked with providing M more hypothesis diagnosis for a patient based on their description and a list of N potential diseases. Your goal is to generate a list of M new potential diseases, each with a short description, and indicate which symptoms the patient has in common with the proposed disease and which symptoms the patient does not have in common.

        Carefully analyze the patient description and consider various potential diseases that could match the symptoms described. For each potential disease:
        1. Provide a brief description of the disease
        2. List the symptoms that the patient has in common with the disease
        3. List the symptoms that the patient has that are not in common with the disease
        
        Present your findings in a JSON format within XML tags. The JSON should contain the following keys for each of the N potential disease:
        - "diagnosis": The name of the potential disease
        - "description": A brief description of the disease
        - "symptoms_in_common": An array of symptoms the patient has that match the disease
        - "symptoms_not_in_common": An array of symptoms the patient has that are not in common with the disease
        
        Here's an example of how your output should be structured:
        
        <diagnosis_output>
        [
        {
            "diagnosis": "some disease N+1",
            "description": "some description",
            "symptoms_in_common": ["symptom1", "symptom2", "symptomN"],
            "symptoms_not_in_common": ["symptom1", "symptom2", "symptomN"]
        },
        ...
        {
            "diagnosis": "some disease N+M",
            "description": "some description",
            "symptoms_in_common": ["symptom1", "symptom2", "symptomN"],
            "symptoms_not_in_common": ["symptom1", "symptom2", "symptomN"]
        }
        ]
        </diagnosis_output>
        
        Present your final output within <diagnosis_output> tags as shown in the example above.
        
        Here is the patient description:
        <patient_description>
        {{description}}
        </patient_description>

        The list of already suggested diseases is:
        <diseases_list>
        {{diseases_list}}
        </diseases_list>`,
        namesOnly2: `Behave like a hypothetical doctor tasked with providing N hypothesis diagnosis for a patient based on their description. Your goal is to generate a list of N potential diseases.
        Carefully analyze the patient description and consider various potential diseases that could match the symptoms described.
        return a valid JSON array with the names of the N most likely diseases or syndromes (from most to least likely). Output only the JSON array, no extra text.

        PATIENT DESCRIPTION
        {{description}}`,
        namesOnly1: `You are an expert clinician. Based on the patient description, list the 5 most likely diseases or syndromes, from most to least likely.

        Return ONLY a valid JSON array of strings, like:
        ["Disease A","Disease B","Disease C","Disease D","Disease E"]

        PATIENT DESCRIPTION
        {{description}}`,
        namesOnly: `You are an expert clinician. Based on the patient description below, list the **5 most likely diseases or syndromes**, ordered from most to least likely.

        • Carefully analyze the patient’s description and consider all plausible conditions that fit the presentation, including common, uncommon, and ultra-rare disorders if relevant.  
        • Do not exclude treatable metabolic/nutritional or structural causes if they match the case.  
        • Important: Return only a valid JSON array of strings with the disease names—no additional text, explanations, or bullet points. Example: ["Disease A","Disease B","Disease C","Disease D","Disease E"]

        PATIENT DESCRIPTION
        {{description}}`,
        namesOnlyExcludingPrevious: `You are an expert clinician. Based on the following patient description, return a valid JSON array with the names of 5 additional diseases or syndromes that are NOT already in the provided list. Return only the JSON array, no extra text.

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
