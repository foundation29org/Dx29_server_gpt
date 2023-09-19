'use strict'

const config = require('../config')
const request = require('request')
const { TextAnalyticsClient, AzureKeyCredential } = require("@azure/ai-text-analytics");
const key = config.TA_KEY;
const endpoint = config.TA_ENDPOINT;
const insights = require('../services/insights')
const textAnalyticsClient = new TextAnalyticsClient(endpoint, new AzureKeyCredential(key));

async function callTextAnalytics (req, res){
  var jsonText = req.body;
  
  console.log("== Recognize Healthcare Entities Sample ==");

  const documents = [
    jsonText.text
  ];
    const poller = await textAnalyticsClient.beginAnalyzeHealthcareEntities(documents, "en", {
        includeStatistics: true
    });

    poller.onProgress(() => {
        console.log(
            `Last time the operation was updated was on: ${poller.getOperationState().lastModifiedOn}`
        );
    });
    console.log(
        `The analyze healthcare entities operation was created on ${poller.getOperationState().createdOn
        }`
    );
    console.log(
        `The analyze healthcare entities operation results will expire on ${poller.getOperationState().expiresOn
        }`
    );

    const results = await poller.pollUntilDone();
    
    let responseResults = [];
    let hasErrors = false;

    for await (const result of results) {
        console.log(`- Document ${result.id}`);
        if (!result.error) {
            console.log("\tRecognized Entities:");
            responseResults.push(result);
        } else {
            insights.error(result.error);
            hasErrors = true;
            responseResults.push({ error: result.error });
        }
    }

    // Send a single response based on the gathered results
    if (hasErrors) {
        res.status(500).send(responseResults);
    } else {
        res.status(200).send(responseResults);
    }
}


module.exports = {
	callTextAnalytics
}
