const azureAIGenomicService = require('../services/azureAIGenomicService');

async function testNHSGenomicService() {
  console.log('🧪 Testing NHS Genomic Service with JSON format...\n');

  try {
    // Test 1: Basic disease query
    console.log('📋 Test 1: Epilepsy query');
    const result1 = await azureAIGenomicService.generateGenomicTestRecommendations(
      'Epilepsy',
      'Patient with early onset seizures before age 2, suspected genetic cause'
    );
    
    console.log('✅ Result 1 received');
    console.log('Has recommendations:', result1.hasRecommendations);
    console.log('Response structure:', JSON.stringify(result1.recommendations, null, 2));
    
    // Validate JSON structure
    if (result1.hasRecommendations && result1.recommendations) {
      const data = result1.recommendations;
      
      // Check required fields
      const hasRequiredFields = 
        data.hasOwnProperty('recommendedTests') &&
        data.hasOwnProperty('eligibilityCriteria') &&
        data.hasOwnProperty('additionalInformation') &&
        data.hasOwnProperty('source');
      
      console.log('✅ JSON structure validation:', hasRequiredFields ? 'PASSED' : 'FAILED');
      
      if (data.recommendedTests && data.recommendedTests.length > 0) {
        const test = data.recommendedTests[0];
        const hasTestFields = 
          test.hasOwnProperty('testCode') &&
          test.hasOwnProperty('testName') &&
          test.hasOwnProperty('targetGenes') &&
          test.hasOwnProperty('testMethod') &&
          test.hasOwnProperty('category');
        
        console.log('✅ Test object structure validation:', hasTestFields ? 'PASSED' : 'FAILED');
      }
    }

    console.log('\n' + '='.repeat(50) + '\n');

    // Test 2: Disease with no specific tests
    console.log('📋 Test 2: Common cold query (should return noTestsFound format)');
    const result2 = await azureAIGenomicService.generateGenomicTestRecommendations(
      'Common cold',
      'Patient with runny nose and cough for 3 days'
    );
    
    console.log('✅ Result 2 received');
    console.log('Has recommendations:', result2.hasRecommendations);
    if (result2.recommendations) {
      console.log('No tests found flag:', result2.recommendations.noTestsFound);
      console.log('Recommended tests count:', result2.recommendations.recommendedTests?.length || 0);
      console.log('Reason:', result2.recommendations.reason);
      
      // Validate noTestsFound structure
      if (result2.recommendations.noTestsFound) {
        const hasNoTestsStructure = 
          result2.recommendations.hasOwnProperty('noTestsFound') &&
          result2.recommendations.hasOwnProperty('reason') &&
          Array.isArray(result2.recommendations.recommendedTests) &&
          result2.recommendations.recommendedTests.length === 0;
        
        console.log('✅ No tests found structure validation:', hasNoTestsStructure ? 'PASSED' : 'FAILED');
      }
    }

    console.log('\n' + '='.repeat(50) + '\n');

    // Test 3: Cancer-related query
    console.log('📋 Test 3: Cancer query');
    const result3 = await azureAIGenomicService.generateGenomicTestRecommendations(
      'Breast cancer',
      'Patient with family history of breast cancer, BRCA testing requested'
    );
    
    console.log('✅ Result 3 received');
    console.log('Has recommendations:', result3.hasRecommendations);
    if (result3.recommendations) {
      console.log('Response structure:', JSON.stringify(result3.recommendations, null, 2));
    }

    console.log('\n' + '='.repeat(50) + '\n');

    // Test 4: Very common condition (should return no tests)
    console.log('📋 Test 4: Hypertension query (should return noTestsFound)');
    const result4 = await azureAIGenomicService.generateGenomicTestRecommendations(
      'Hypertension',
      'Patient with high blood pressure, no family history of genetic conditions'
    );
    
    console.log('✅ Result 4 received');
    console.log('Has recommendations:', result4.hasRecommendations);
    if (result4.recommendations) {
      console.log('No tests found flag:', result4.recommendations.noTestsFound);
      console.log('Reason:', result4.recommendations.reason);
    }

    console.log('\n' + '='.repeat(50) + '\n');

    // Test 5: Rare genetic condition (should return tests)
    console.log('📋 Test 5: Cystic fibrosis query');
    const result5 = await azureAIGenomicService.generateGenomicTestRecommendations(
      'Cystic fibrosis',
      'Patient with respiratory symptoms and positive sweat test'
    );
    
    console.log('✅ Result 5 received');
    console.log('Has recommendations:', result5.hasRecommendations);
    if (result5.recommendations) {
      console.log('No tests found flag:', result5.recommendations.noTestsFound);
      console.log('Recommended tests count:', result5.recommendations.recommendedTests?.length || 0);
    }

    console.log('\n' + '='.repeat(50) + '\n');

    // Test 4: Connection test
    console.log('📋 Test 4: Connection test');
    const connectionTest = await azureAIGenomicService.testConnection();
    console.log('Connection result:', connectionTest);

    console.log('\n🎉 All tests completed!');

  } catch (error) {
    console.error('❌ Test failed:', error);
    console.error('Error details:', error.message);
  }
}

// Run the test
testNHSGenomicService(); 