/**
 * Example of the expected JSON response format from NHS Genomic Service
 * This shows the structure that the Azure AI Studio assistant should return
 */

const expectedResponseFormat = {
  "recommendedTests": [
    {
      "testCode": "R59.3",
      "testName": "Early onset or syndromic epilepsy",
      "targetGenes": "Early onset or syndromic epilepsy (402)",
      "testMethod": "WGS (Whole Genome Sequencing)",
      "category": "Specialized"
    },
    {
      "testCode": "R59.4",
      "testName": "Epilepsy with intellectual disability",
      "targetGenes": "Epilepsy with intellectual disability (156)",
      "testMethod": "WGS (Whole Genome Sequencing)",
      "category": "Specialized"
    }
  ],
  "eligibilityCriteria": {
    "documentSection": "XVII Neurology",
    "nhsCriteria": "Unexplained epilepsy with clinical suspicion of a monogenic cause, including onset before 2 years or clinical characteristics suggestive of specific genetic epilepsy, such as Dravet syndrome.",
    "specialties": ["Clinical Genetics", "Neurology", "Metabolic Medicine"]
  },
  "additionalInformation": {
    "applicationProcess": "Referrals for tests will be classified by the Genomic Laboratory; tests should be directed to those where a genetic or genomic diagnosis will guide the management of the proband or the family.",
    "expectedResponseTimes": "Generally, it varies according to the laboratory's workload; specific times can be confirmed in the application.",
    "specialConsiderations": "Occasionally, tests may be appropriate when the age of onset is between 2 and 3 years and with prior clinical agreement from a specialist Multidisciplinary Team (MDT)."
  },
  "source": "NHS Genomic Test Directory"
};

// Example of response when no tests are found
const noTestsFoundFormat = {
  "recommendedTests": [],
  "eligibilityCriteria": {
    "documentSection": "Not applicable",
    "nhsCriteria": "No specific genetic tests available for this condition in the NHS Genomic Test Directory.",
    "specialties": []
  },
  "additionalInformation": {
    "applicationProcess": "Please consult with a clinical geneticist for alternative testing options or referral to specialist services.",
    "expectedResponseTimes": "Not applicable",
    "specialConsiderations": "Consider referral to clinical genetics for assessment of whether genetic testing might be appropriate through other pathways."
  },
  "source": "NHS Genomic Test Directory",
  "noTestsFound": true,
  "reason": "Condition not covered by NHS genetic testing directory"
};

// Example of error response
const errorResponseFormat = {
  "recommendedTests": [],
  "eligibilityCriteria": {
    "documentSection": "Error",
    "nhsCriteria": "Unable to process request at this time.",
    "specialties": []
  },
  "additionalInformation": {
    "applicationProcess": "Please consult with a clinical geneticist.",
    "expectedResponseTimes": "Not available",
    "specialConsiderations": "System temporarily unavailable."
  },
  "source": "NHS Genomic Test Directory",
  "error": "Failed to parse AI response"
};

console.log('📋 Expected JSON Response Format:');
console.log(JSON.stringify(expectedResponseFormat, null, 2));

console.log('\n📋 No Tests Found Format:');
console.log(JSON.stringify(noTestsFoundFormat, null, 2));

console.log('\n📋 Error Response Format:');
console.log(JSON.stringify(errorResponseFormat, null, 2));

module.exports = {
  expectedResponseFormat,
  noTestsFoundFormat,
  errorResponseFormat
}; 