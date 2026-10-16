<div style="margin-bottom: 1%; padding-bottom: 2%;">
	<img align="right" width="100px" src="/img/logo-Dx29.png">
</div>			

DxGPT Server
===============================================================================================================================

#### 1. Overview
DxGPT is a diagnostic decision support tool based on advanced AI language models. From a description of symptoms it generates a list of possible diseases and the information that would help refine it. Because the models can make mistakes, DxGPT is a support tool for professionals and **must not be used as a substitute for medical judgment**.

This repository is the API (Node.js / Express). The web client lives here: [DxGPT client](https://github.com/foundation29org/Dx29_client_gpt).

For evaluation methodology and results, see the [evaluation repository and the associated article](https://github.com/foundation29org/dxgpt_testing).

#### 2. Getting started

```bash
npm install
cp env.example env.local   # fill in your own values; never commit it
npm run dev
npm test
```

#### 3. API contract

The public OpenAPI contract is in `docs/apim`.

```bash
npm run validate-openapi
npm run swagger-ui
```

#### 4. Security audit skill

`.github/skills/security-audit` vendors Cloudflare's [security-audit skill](https://github.com/cloudflare/security-audit-skill) (MIT, commit `c1c8a8c`) for coding agents such as GitHub Copilot CLI. Ask the agent to `security audit this codebase` for a full audit, or ask a focused security question for guidance mode. Full-audit artifacts go to `~/security-audit-skill/<repo-name>/run-<N>` by default, outside this repository.

The bundled validators (`validate-findings.cjs`, `validate-coverage-ledger.cjs`) need Node.js and refuse to read input on Windows, where `O_NOFOLLOW` is unavailable; run audits from Linux, macOS, or WSL. See [`security/README.md`](security/README.md) for details.

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
			Copyright © 2025-2026
			<a style="color:#009DA0" href="https://www.foundation29.org/" target="_blank"> Foundation29</a>
		</p>
	</div>
</div>
