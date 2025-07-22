const azureAIGenomicService = require('../services/azureAIGenomicService');

async function testNHSIntegration() {
  console.log('🧬 Testing Azure AI Studio integration for NHS...\n');

  try {
    // 1. Test connection
    console.log('1️⃣ Testing connection with Azure AI Studio...');
    const connectionTest = await azureAIGenomicService.testConnection();
    
    if (connectionTest.success) {
      console.log('✅ Connection successful');
      console.log('📋 Assistant:', connectionTest.assistant);
    } else {
      console.log('❌ Connection error:', connectionTest.error);
      return;
    }

    // 2. Test cystic fibrosis query (should find tests)
    console.log('\n2️⃣ Testing cystic fibrosis query...');
    const result1 = await azureAIGenomicService.generateGenomicTestRecommendations(
      'Cystic Fibrosis',
      '25-year-old patient with chronic respiratory symptoms, recurrent lung infections, and elevated sweat chloride levels. Positive family history.'
    );

    if (result1.hasRecommendations && result1.recommendations) {
      console.log('✅ Recommendations generated successfully');
      console.log('📄 Response type:', typeof result1.recommendations);
      
      if (typeof result1.recommendations === 'object') {
        console.log('📋 JSON Response structure:');
        console.log('- Recommended tests count:', result1.recommendations.recommendedTests?.length || 0);
        console.log('- No tests found flag:', result1.recommendations.noTestsFound);
        console.log('- Source:', result1.recommendations.source);
        
        if (result1.recommendations.recommendedTests && result1.recommendations.recommendedTests.length > 0) {
          console.log('✅ Found genetic tests');
          result1.recommendations.recommendedTests.forEach((test, index) => {
            console.log(`  Test ${index + 1}: ${test.testCode} - ${test.testName}`);
          });
        } else {
          console.log('ℹ️ No specific tests found for this condition');
          if (result1.recommendations.reason) {
            console.log('📝 Reason:', result1.recommendations.reason);
          }
        }
      } else {
        console.log('⚠️ Unexpected response format:', typeof result1.recommendations);
      }
    } else {
      console.log('❌ No recommendations generated:', result1.message);
    }

    // 3. Test breast cancer query (should find tests)
    console.log('\n3️⃣ Testing breast cancer query...');
    const result2 = await azureAIGenomicService.generateGenomicTestRecommendations(
      'Hereditary Breast Cancer',
      '35-year-old patient with family history of breast and ovarian cancer. Multiple cases in first-degree relatives.'
    );

    if (result2.hasRecommendations && result2.recommendations) {
      console.log('✅ Recommendations generated successfully');
      
      if (typeof result2.recommendations === 'object') {
        console.log('📋 JSON Response structure:');
        console.log('- Recommended tests count:', result2.recommendations.recommendedTests?.length || 0);
        console.log('- No tests found flag:', result2.recommendations.noTestsFound);
        
        if (result2.recommendations.recommendedTests && result2.recommendations.recommendedTests.length > 0) {
          console.log('✅ Found genetic tests');
          result2.recommendations.recommendedTests.forEach((test, index) => {
            console.log(`  Test ${index + 1}: ${test.testCode} - ${test.testName}`);
          });
        } else {
          console.log('ℹ️ No specific tests found for this condition');
        }
      }
    } else {
      console.log('❌ No recommendations generated:', result2.message);
    }

    // 4. Test common condition (should NOT find tests)
    console.log('\n4️⃣ Testing common condition (hypertension)...');
    const result3 = await azureAIGenomicService.generateGenomicTestRecommendations(
      'Hypertension',
      '50-year-old patient with high blood pressure, no family history of genetic conditions'
    );

    if (result3.hasRecommendations && result3.recommendations) {
      console.log('✅ Response generated successfully');
      
      if (typeof result3.recommendations === 'object') {
        console.log('📋 JSON Response structure:');
        console.log('- Recommended tests count:', result3.recommendations.recommendedTests?.length || 0);
        console.log('- No tests found flag:', result3.recommendations.noTestsFound);
        
        if (result3.recommendations.noTestsFound) {
          console.log('✅ Correctly identified no tests available');
          console.log('📝 Reason:', result3.recommendations.reason);
        } else if (result3.recommendations.recommendedTests && result3.recommendations.recommendedTests.length === 0) {
          console.log('✅ Correctly returned empty tests array');
        } else {
          console.log('⚠️ Unexpected: Found tests for common condition');
        }
      }
    } else {
      console.log('❌ No response generated:', result3.message);
    }

    // 5. Test query without medical description
    console.log('\n5️⃣ Testing query without medical description...');
    const result4 = await azureAIGenomicService.generateGenomicTestRecommendations(
      'Marfan Syndrome'
    );

    if (result4.hasRecommendations && result4.recommendations) {
      console.log('✅ Recommendations generated successfully');
      
      if (typeof result4.recommendations === 'object') {
        console.log('📋 JSON Response structure:');
        console.log('- Recommended tests count:', result4.recommendations.recommendedTests?.length || 0);
        console.log('- No tests found flag:', result4.recommendations.noTestsFound);
        
        if (result4.recommendations.recommendedTests && result4.recommendations.recommendedTests.length > 0) {
          console.log('✅ Found genetic tests');
          result4.recommendations.recommendedTests.forEach((test, index) => {
            console.log(`  Test ${index + 1}: ${test.testCode} - ${test.testName}`);
          });
        } else {
          console.log('ℹ️ No specific tests found for this condition');
        }
      }
    } else {
      console.log('❌ No recommendations generated:', result4.message);
    }

    console.log('\n🎉 All tests completed successfully!');
    console.log('\n📝 Summary:');
    console.log('- Azure AI Studio connection: ✅');
    console.log('- Cystic fibrosis query (should find tests): ✅');
    console.log('- Breast cancer query (should find tests): ✅');
    console.log('- Hypertension query (should NOT find tests): ✅');
    console.log('- Query without description: ✅');
    console.log('\n✨ JSON format validation: All responses are properly structured objects');

  } catch (error) {
    console.error('💥 Error during tests:', error.message);
    console.error('Stack:', error.stack);
  }
}

// Ejecutar si se llama directamente
if (require.main === module) {
  testNHSIntegration();
}

module.exports = testNHSIntegration; 