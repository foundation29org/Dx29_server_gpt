'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const options = {
    days: DEFAULT_DAYS,
    envFile: path.resolve(__dirname, '..', 'env.prod')
  };

  argv.forEach((arg) => {
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      return;
    }

    if (arg.startsWith('--days=')) {
      const days = Number.parseInt(arg.split('=')[1], 10);
      if (!Number.isNaN(days) && days > 0) {
        options.days = days;
      }
      return;
    }

    if (arg.startsWith('--env-file=')) {
      const providedPath = arg.split('=')[1];
      if (providedPath) {
        options.envFile = path.resolve(process.cwd(), providedPath);
      }
    }
  });

  return options;
}

function printHelp() {
  console.log('Uso: node scripts/daily-operation-durations.js [opciones]');
  console.log('');
  console.log('Opciones:');
  console.log('  --days=<n>         Dias hacia atras para analizar (default: 7)');
  console.log('  --env-file=<path>  Ruta al archivo de entorno (default: ./env.prod)');
  console.log('  --help, -h         Muestra esta ayuda');
}

function parseEnvFile(envFilePath) {
  const content = fs.readFileSync(envFilePath, 'utf8');
  const result = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }

    const equalIndex = line.indexOf('=');
    if (equalIndex === -1) {
      continue;
    }

    const key = line.slice(0, equalIndex).trim();
    let value = line.slice(equalIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith('\'') && value.endsWith('\''))
    ) {
      value = value.slice(1, -1);
    }

    result[key] = value;
  }

  return result;
}

function getMongoCredentials(envValues) {
  const mongoKey = envValues.MONGODBKEY_PROD;
  const mongoName = envValues.MONGODBNAME_PROD;

  if (!mongoKey || !mongoName) {
    throw new Error('No se encontraron MONGODBKEY_PROD o MONGODBNAME_PROD en el archivo de entorno.');
  }

  return { mongoKey, mongoName };
}

function printOperationTable(rows) {
  if (!rows.length) {
    console.log('\nNo hay datos de operaciones en el rango indicado.');
    return;
  }

  console.log('\n=== Promedio diario por operacion (ms) ===');
  console.table(
    rows.map((row) => ({
      date: row._id.date,
      operation: row._id.operation,
      count: row.count,
      avgOperationDurationMs: Number(row.avgOperationDurationMs.toFixed(2))
    }))
  );
}

function printStageTable(rows) {
  if (!rows.length) {
    console.log('\nNo hay datos de suboperaciones en el rango indicado.');
    return;
  }

  console.log('\n=== Promedio diario por suboperacion (ms) ===');
  console.table(
    rows.map((row) => ({
      date: row._id.date,
      operation: row._id.operation,
      stage: row._id.stage,
      count: row.count,
      avgStageDurationMs: Number(row.avgStageDurationMs.toFixed(2))
    }))
  );
}

async function getDailyOperationAverages(CostTrackingModel, startDate) {
  return CostTrackingModel.aggregate([
    {
      $match: {
        createdAt: { $gte: startDate }
      }
    },
    {
      $addFields: {
        operationDurationMs: {
          $sum: {
            $map: {
              input: { $ifNull: ['$stages', []] },
              as: 'stage',
              in: { $ifNull: ['$$stage.duration', 0] }
            }
          }
        },
        date: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$createdAt'
          }
        }
      }
    },
    {
      $group: {
        _id: {
          date: '$date',
          operation: '$operation'
        },
        count: { $sum: 1 },
        avgOperationDurationMs: { $avg: '$operationDurationMs' }
      }
    },
    {
      $sort: {
        '_id.date': 1,
        '_id.operation': 1
      }
    }
  ]);
}

async function getDailyStageAverages(CostTrackingModel, startDate) {
  return CostTrackingModel.aggregate([
    {
      $match: {
        createdAt: { $gte: startDate }
      }
    },
    { $unwind: '$stages' },
    {
      $addFields: {
        date: {
          $dateToString: {
            format: '%Y-%m-%d',
            date: '$createdAt'
          }
        }
      }
    },
    {
      $group: {
        _id: {
          date: '$date',
          operation: '$operation',
          stage: '$stages.name'
        },
        count: { $sum: 1 },
        avgStageDurationMs: { $avg: { $ifNull: ['$stages.duration', 0] } }
      }
    },
    {
      $sort: {
        '_id.date': 1,
        '_id.operation': 1,
        '_id.stage': 1
      }
    }
  ]);
}

async function run() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printHelp();
    return;
  }

  const envValues = parseEnvFile(options.envFile);
  const { mongoKey, mongoName } = getMongoCredentials(envValues);
  process.env.MONGO_KEY = mongoKey;
  process.env.MONGO_NAME = mongoName;
  process.env.NODE_ENV = 'production';

  const mongoose = require('../db_connect');
  const CostTracking = require('../models/costTracking');
  const startDate = new Date(Date.now() - options.days * MS_PER_DAY);

  console.log(`Analizando desde ${startDate.toISOString()} (ultimos ${options.days} dias)...`);

  const [operationAverages, stageAverages] = await Promise.all([
    getDailyOperationAverages(CostTracking, startDate),
    getDailyStageAverages(CostTracking, startDate)
  ]);

  printOperationTable(operationAverages);
  printStageTable(stageAverages);

  await mongoose.disconnect();
}

run().catch(async (error) => {
  console.error('Error ejecutando el reporte de duraciones:', error.message);
  try {
    const mongoose = require('../db_connect');
    await mongoose.disconnect();
  } catch (disconnectError) {
    // Ignorado intencionalmente
  }
  process.exitCode = 1;
});
