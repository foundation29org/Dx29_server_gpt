# Skill de auditoría de seguridad

Este repositorio incluye la skill [`security-audit`](https://github.com/cloudflare/security-audit-skill) de Cloudflare para que agentes de código (GitHub Copilot CLI y similares) puedan revisar la seguridad de DxGPT Server.

## Qué se ha añadido

| Elemento | Detalle |
| --- | --- |
| Ubicación | `.github/skills/security-audit/` (ruta donde Copilot CLI busca skills del proyecto) |
| Origen | `cloudflare/security-audit-skill`, commit [`c1c8a8c`](https://github.com/cloudflare/security-audit-skill/tree/c1c8a8c1471069fb0e188eeaff69b8e8db6564a8) |
| Licencia | MIT; copia en `.github/skills/security-audit/LICENSE` |
| Contenido | `SKILL.md`, guías por fase y por clase de ataque, `report-schema.json` y los validadores `validate-findings.cjs` y `validate-coverage-ledger.cjs` con sus tests |
| Cambios locales | Ninguno. Los 21 archivos coinciden byte a byte con upstream (comparación de hashes de blob de git) |

El CLI oficial (`npx skills add`) se quedó bloqueado, así que los archivos se copiaron directamente desde un clon del repositorio upstream.

## Cómo usarla

Abre el agente en la raíz del repositorio y pídele, por ejemplo:

```text
security audit this codebase
```

```text
find security vulnerabilities in ./services
```

La skill tiene dos modos:

- **Guía**: preguntas de seguridad o revisiones acotadas. No crea archivos.
- **Auditoría completa**: se activa al pedir explícitamente una auditoría, un pen-test o informes. Ejecuta seis fases (reconocimiento, búsqueda, validación de candidatos, salida estructurada, verificación independiente e informe).

Por defecto, los resultados de una auditoría completa se escriben fuera del repositorio, en `~/security-audit-skill/<repo-name>/run-<N>`:

- `architecture.md` y `coverage-ledger.json`
- `findings.json` (veredictos `confirmed`, `needs_validation` y `rejected`)
- `REPORT.md`, `FINDINGS-DETAIL.md` y `NEEDS-VALIDATION.md`

Ejecutar la auditoría varias veces amplía la cobertura: cada ejecución reutiliza los resultados anteriores.

## Requisitos

- Un agente con herramientas y subagentes en paralelo.
- Node.js para los validadores, que no tienen dependencias.
- Un sandbox del sistema operativo (sin red externa, entorno saneado, límites de recursos y escritura solo en `scratch/`) si el agente necesita ejecutar código del repositorio. Sin él, la skill deja los hallazgos como `needs_validation` en lugar de ejecutar nada.

## Limitación en Windows

Los validadores exigen `O_NOFOLLOW` y `O_NONBLOCK`, que Windows no ofrece, y se niegan a leer la entrada en ese sistema. Resultado de los tests en Windows con Node.js 24:

| Total | Pasan | Fallan | Omitidos |
| ---: | ---: | ---: | ---: |
| 65 | 46 | 7 | 12 |

Los 7 fallos dan el mismo error: `OS no-follow and nonblocking input protection is unavailable`. Los 12 omitidos son tests exclusivos de POSIX. No se pudieron comprobar en Linux porque la máquina no tenía WSL ni Docker. **Ejecuta las auditorías completas desde Linux, macOS o WSL.**

Para ejecutar los tests:

```bash
cd .github/skills/security-audit
node --test validate-findings.test.cjs validate-coverage-ledger.test.cjs
```

## Actualizar a una versión nueva

```bash
tmp=$(mktemp -d)
git clone --depth 1 https://github.com/cloudflare/security-audit-skill "$tmp"
rm -rf .github/skills/security-audit
cp -R "$tmp/skills/security-audit" .github/skills/security-audit
cp "$tmp/LICENSE" .github/skills/security-audit/LICENSE
git -C "$tmp" rev-parse HEAD   # actualiza el commit en este archivo y en el README principal
rm -rf "$tmp"
```

Después, vuelve a ejecutar los tests y revisa el diff antes de hacer commit.
