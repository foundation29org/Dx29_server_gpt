const axios = require('axios');

// Simular la respuesta JSON del servicio Azure AI Genomic
const mockGenomicResponse = {
  hasRecommendations: true,
  recommendations: {
    recommendedTests: [
      {
        testCode: 'R59.3',
        testName: 'Early onset or syndromic epilepsy',
        targetGenes: 'Genetic epilepsy syndromes (402)',
        testMethod: 'WGS (Whole Genome Sequencing)',
        category: 'Specialized'
      }
    ],
    eligibilityCriteria: {
      documentSection: 'Section 3.2 - Neurological conditions',
      nhsCriteria: 'Patients with early onset epilepsy before age 2 years',
      specialties: ['Neurology', 'Clinical Genetics']
    },
    additionalInformation: {
      applicationProcess: 'Submit through NHS Genomic Medicine Service',
      expectedResponseTimes: '4-6 weeks',
      specialConsiderations: 'Requires specialist referral'
    },
    source: 'NHS Genomic Test Directory'
  }
};

// Función para simular la traducción
async function translateInvertWithRetry(text, toLang) {
  // Simular traducción al español
  const translations = {
    'test:': 'prueba:',
    'Test name:': 'Nombre de la prueba:',
    'Target genes:': 'Genes diana:',
    'Test method:': 'Método de prueba:',
    'Category:': 'Categoría:',
    'LIST OF RECOMMENDED TESTS:': 'LISTA DE PRUEBAS RECOMENDADAS:',
    'ELIGIBILITY CRITERIA:': 'CRITERIOS DE ELEGIBILIDAD:',
    'ADDITIONAL INFORMATION:': 'INFORMACIÓN ADICIONAL:',
    'Source:': 'Fuente:'
  };
  
  return translations[text] || text;
}

// Función para procesar la respuesta como en el código real
async function processGenomicResponse(data, detectedLang = 'en') {
  let processedContent = '';
  
  if (data.hasRecommendations && data.recommendations) {
    const responseData = data.recommendations;
    
    // Verificar si no se encontraron pruebas
    const noTestsFound = responseData.noTestsFound === true || 
                        (responseData.recommendedTests && responseData.recommendedTests.length === 0);
    
    if (noTestsFound) {
      // Caso: No hay pruebas genéticas disponibles
      let noTestsLabels = {
        consultationResult: 'CONSULTATION RESULT:',
        noTestsFound: 'No specific genetic tests were found in the NHS directory for this condition.',
        reason: 'Reason:',
        alternativeRecommendations: 'ALTERNATIVE RECOMMENDATIONS:',
        suggestedNextSteps: 'SUGGESTED NEXT STEPS:',
        applicationProcess: 'Application process:',
        specialConsiderations: 'Special considerations:',
        consultGeneticist: 'Consult with a clinical geneticist for individualized assessment',
        considerPathways: 'Consider whether the condition might qualify for testing through other pathways',
        evaluateResearch: 'Evaluate if research or commercial tests are available',
        reviewCriteria: 'Review if there are special eligibility criteria that might apply'
      };
      
      // Traducir etiquetas si es necesario
      if (detectedLang !== 'en') {
        try {
          const labelsToTranslate = Object.values(noTestsLabels);
          const translatedLabels = await Promise.all(
            labelsToTranslate.map(label => translateInvertWithRetry(label, detectedLang))
          );
          
          // Actualizar las etiquetas traducidas
          Object.keys(noTestsLabels).forEach((key, index) => {
            noTestsLabels[key] = translatedLabels[index];
          });
          
        } catch (translationError) {
          console.error('Translation error for no-tests labels:', translationError);
        }
      }
      
      processedContent = `<p><strong>${noTestsLabels.consultationResult}</strong></p>`;
      processedContent += `<p><strong>${noTestsLabels.noTestsFound}</strong></p>`;
      
      if (responseData.reason) {
        processedContent += `<p><strong>${noTestsLabels.reason}</strong> ${responseData.reason}</p>`;
      }
      
      processedContent += `<p><strong>${noTestsLabels.alternativeRecommendations}</strong></p>`;
      if (responseData.additionalInformation) {
        processedContent += '<ul>';
        processedContent += `<li><strong>${noTestsLabels.applicationProcess}</strong> ${responseData.additionalInformation.applicationProcess}</li>`;
        processedContent += `<li><strong>${noTestsLabels.specialConsiderations}</strong> ${responseData.additionalInformation.specialConsiderations}</li>`;
        processedContent += '</ul>';
      }
      
      processedContent += `<p><strong>${noTestsLabels.suggestedNextSteps}</strong></p>`;
      processedContent += '<ul>';
      processedContent += `<li>${noTestsLabels.consultGeneticist}</li>`;
      processedContent += `<li>${noTestsLabels.considerPathways}</li>`;
      processedContent += `<li>${noTestsLabels.evaluateResearch}</li>`;
      processedContent += `<li>${noTestsLabels.reviewCriteria}</li>`;
      processedContent += '</ul>';
      
    } else {
      // Caso: Se encontraron pruebas genéticas
      let sectionTitles = {
        listTitle: 'LIST OF RECOMMENDED TESTS:',
        eligibilityTitle: 'ELIGIBILITY CRITERIA:',
        additionalTitle: 'ADDITIONAL INFORMATION:',
        source: 'Source:'
      };
      
      let fieldLabels = {
        test: 'test:',
        testName: 'Test name:',
        targetGenes: 'Target genes:',
        testMethod: 'Test method:',
        category: 'Category:',
        documentSection: 'Section of the eligibility document:',
        nhsCriteria: 'NHS specific criteria:',
        specialties: 'Specialties that can request the test:',
        applicationProcess: 'Application process:',
        expectedResponseTimes: 'Expected response times:',
        specialConsiderations: 'Special considerations:'
      };
      
      // Traducir etiquetas si es necesario
      if (detectedLang !== 'en') {
        try {
          const labelsToTranslate = Object.values(fieldLabels).concat(Object.values(sectionTitles));
          const translatedLabels = await Promise.all(
            labelsToTranslate.map(label => translateInvertWithRetry(label, detectedLang))
          );
          
          // Actualizar las etiquetas traducidas
          const labelKeys = Object.keys(fieldLabels);
          const titleKeys = Object.keys(sectionTitles);
          
          labelKeys.forEach((key, index) => {
            fieldLabels[key] = translatedLabels[index];
          });
          
          titleKeys.forEach((key, index) => {
            sectionTitles[key] = translatedLabels[labelKeys.length + index];
          });
          
        } catch (translationError) {
          console.error('Translation error for labels:', translationError);
        }
      }
      
      processedContent = `<p><strong>${sectionTitles.listTitle}</strong></p>`;
      
      if (responseData.recommendedTests && responseData.recommendedTests.length > 0) {
        processedContent += '<ul>';
        responseData.recommendedTests.forEach(test => {
          processedContent += `<li><strong>${fieldLabels.test}</strong> ${test.testCode}</li>`;
          processedContent += `<li><strong>${fieldLabels.testName}</strong> ${test.testName}</li>`;
          processedContent += `<li><strong>${fieldLabels.targetGenes}</strong> ${test.targetGenes}</li>`;
          processedContent += `<li><strong>${fieldLabels.testMethod}</strong> ${test.testMethod}</li>`;
          processedContent += `<li><strong>${fieldLabels.category}</strong> ${test.category}</li>`;
        });
        processedContent += '</ul>';
      }
      
      processedContent += `<p><strong>${sectionTitles.eligibilityTitle}</strong></p>`;
      if (responseData.eligibilityCriteria) {
        processedContent += '<ul>';
        processedContent += `<li><strong>${fieldLabels.documentSection}</strong> ${responseData.eligibilityCriteria.documentSection}</li>`;
        processedContent += `<li><strong>${fieldLabels.nhsCriteria}</strong> ${responseData.eligibilityCriteria.nhsCriteria}</li>`;
        if (responseData.eligibilityCriteria.specialties && responseData.eligibilityCriteria.specialties.length > 0) {
          processedContent += `<li><strong>${fieldLabels.specialties}</strong> ${responseData.eligibilityCriteria.specialties.join(', ')}</li>`;
        }
        processedContent += '</ul>';
      }
      
      processedContent += `<p><strong>${sectionTitles.additionalTitle}</strong></p>`;
      if (responseData.additionalInformation) {
        processedContent += '<ul>';
        processedContent += `<li><strong>${fieldLabels.applicationProcess}</strong> ${responseData.additionalInformation.applicationProcess}</li>`;
        processedContent += `<li><strong>${fieldLabels.expectedResponseTimes}</strong> ${responseData.additionalInformation.expectedResponseTimes}</li>`;
        processedContent += `<li><strong>${fieldLabels.specialConsiderations}</strong> ${responseData.additionalInformation.specialConsiderations}</li>`;
        processedContent += '</ul>';
      }
    }
    
    processedContent += `<p>${sectionTitles.source} ${responseData.source || 'NHS Genomic Test Directory'}</p>`;
  } else {
    processedContent = `<p><strong>Error</strong></p><p>${data.message || 'Unable to generate recommendations at this time. Please consult with a clinical geneticist.'}</p>`;
  }
  
  return processedContent;
}

// Función de prueba
async function testTranslation() {
  console.log('=== Testing NHS Genomic Translation ===\n');
  
  // Probar en inglés
  console.log('1. Testing in English:');
  const englishResult = await processGenomicResponse(mockGenomicResponse, 'en');
  console.log(englishResult);
  console.log('\n' + '='.repeat(50) + '\n');
  
  // Probar en español
  console.log('2. Testing in Spanish:');
  const spanishResult = await processGenomicResponse(mockGenomicResponse, 'es');
  console.log(spanishResult);
  console.log('\n' + '='.repeat(50) + '\n');
  
  // Verificar que la estructura HTML se mantiene
  console.log('3. HTML Structure Validation:');
  const englishLines = englishResult.split('\n');
  const spanishLines = spanishResult.split('\n');
  
  console.log('English has', englishLines.length, 'lines');
  console.log('Spanish has', spanishLines.length, 'lines');
  
  // Verificar que las etiquetas <li> están completas
  const englishLiCount = (englishResult.match(/<li>/g) || []).length;
  const spanishLiCount = (spanishResult.match(/<li>/g) || []).length;
  
  console.log('English has', englishLiCount, '<li> tags');
  console.log('Spanish has', spanishLiCount, '<li> tags');
  
  if (englishLiCount === spanishLiCount) {
    console.log('✅ HTML structure is preserved correctly');
  } else {
    console.log('❌ HTML structure is broken');
  }
  
  // Verificar que no hay líneas incompletas
  const incompleteLines = spanishLines.filter(line => 
    line.includes('<strong>') && !line.includes('</strong>') && !line.includes('</li>')
  );
  
  if (incompleteLines.length === 0) {
    console.log('✅ No incomplete HTML tags found');
  } else {
    console.log('❌ Found incomplete HTML tags:', incompleteLines);
  }
}

// Ejecutar la prueba
testTranslation().catch(console.error); 