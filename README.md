<div style="margin-bottom: 1%; padding-bottom: 2%;">
	<img align="right" width="100px" src="/img/logo-Dx29.png">
</div>			

DxGPT Server
===============================================================================================================================

#### 1. Overview
DxGPT is a diagnostic decision support software based on GPT-4. GPT-4 is an Artificial Intelligence (AI) language model developed by OpenAI. It is designed to generate text from previous input. This means that the software can generate a list of diseases from a description of symptoms. However, due to the characteristics of the model, there is a possibility that the software has errors. Therefore, it should not be used for medical use.

Once the list of diseases is generated, it can be completed with further information to refine the diagnosis. This includes collecting clinical data, performing laboratory tests, and gathering information from the medical record. This will help clinicians make a more informed decision about the diagnosis. It is important that users give us feedback on the use of the software so that we can improve the model. This is important because it helps us to better understand how the software is being used and how we can improve it.

We are currently working on developing new features for the software. We are looking for collaborators who want to investigate the use of these models in diagnostics. If you are interested, please contact us for more information.

#### 2. Current model accuracy

In a recent preliminary evaluation conducted by Foundation 29 using 200 synthetic patient cases generated by language models, DxGPT demonstrated some ability to suggest correct diagnoses of rare diseases. Specifically, when evaluated for strict accuracy (i.e., whether the correct diagnosis appeared in first position), DxGPT obtained an accuracy of 67.5%, getting the diagnosis right in 135 of the 200 cases. If a more flexible metric is considered, counting correct diagnoses in both the first and first 5 positions, the accuracy increases to 88.5% (177 out of 200 cases). While these initial results are encouraging, DxGPT is still at an early stage of development.

For more details on the evaluation methodology and results, please see our [GitHub repository and the associated article.](https://github.com/foundation29org/dxgpt_testing)

<br>
<br>

The client code is here: [Dx29 client](https://github.com/foundation29org/Dx29_client_gpt)
<p>&nbsp;</p>
<p>&nbsp;</p>


<div style="border-top: 1px solid !important;
	padding-top: 1% !important;
    padding-right: 1% !important;
    padding-bottom: 0.1% !important;">
	<div align="right">
		<img width="150px" src="/img/logo-foundation-twentynine-footer.png">
	</div>
	<div align="right" style="padding-top: 0.5% !important">
		<p align="right">
			Copyright © 2024
			<a style="color:#009DA0" href="https://www.foundation29.org/" target="_blank"> Foundation29</a>
		</p>
	</div>
<div>
