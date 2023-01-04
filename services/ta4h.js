'use strict'

const config = require('../config')
const request = require('request')
const { TextAnalyticsClient, AzureKeyCredential } = require("@azure/ai-text-analytics");
const key = config.TA_KEY;
const endpoint = config.TA_ENDPOINT;
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
    
    for await (const result of results) {
        console.log(`- Document ${result.id}`);
        if (!result.error) {
            console.log("\tRecognized Entities:");
            res.status(200).send(result)
            /*for (const entity of result.entities) {
                console.log(`\t- Entity "${entity.text}" of type ${entity.category}`);
            }
            if (result.entityRelations && (result.entityRelations.length > 0)) {
                console.log(`\tRecognized relations between entities:`);
                for (const relation of result.entityRelations) {
                    console.log(
                        `\t\t- Relation of type ${relation.relationType} found between the following entities:`
                    );
                    for (const role of relation.roles) {
                        console.log(`\t\t\t- "${role.entity.text}" with the role ${role.name}`);
                    }
                }
            }*/
        } else res.status(500).send(result.error)
    }
}


module.exports = {
	callTextAnalytics
}
