const fs = require('fs');
const path = require('path');
const swaggerJsdoc = require('swagger-jsdoc');

// Configuración similar a la de app.js
const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'DXGPT API',
      version: '1.0.0',
      description: 'API for DXGPT services',
      contact: {
        name: 'DXGPT Support'
      }
    },
    servers: [
      {
        url: '/v1',
        description: 'API Version 1'
      }
    ],
    components: {
      securitySchemes: {
        BearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      },
      schemas: {
        Language: {
          type: 'object',
          properties: {
            code: {
              type: 'string',
              example: 'en'
            },
            name: {
              type: 'string',
              example: 'English'
            }
          }
        },
        SupportRequest: {
          type: 'object',
          properties: {
            email: {
              type: 'string',
              format: 'email'
            },
            message: {
              type: 'string'
            }
          },
          required: ['email', 'message']
        },
        DiagnoseRequest: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string'
            },
            model: {
              type: 'string',
              example: 'gpt-4'
            },
            temperature: {
              type: 'number',
              format: 'float',
              example: 0.7
            }
          },
          required: ['prompt']
        },
        DiagnoseResponse: {
          type: 'object',
          properties: {
            text: {
              type: 'string'
            },
            usage: {
              type: 'object',
              properties: {
                prompt_tokens: {
                  type: 'integer'
                },
                completion_tokens: {
                  type: 'integer'
                },
                total_tokens: {
                  type: 'integer'
                }
              }
            }
          }
        },
        QuestionsRequest: {
          type: 'object',
          properties: {
            context: {
              type: 'string'
            },
            count: {
              type: 'integer',
              example: 5
            }
          },
          required: ['context']
        },
        QuestionsResponse: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              items: {
                type: 'string'
              }
            }
          }
        },
        FollowUpQuestionsRequest: {
          type: 'object',
          properties: {
            context: {
              type: 'string'
            },
            previousQuestions: {
              type: 'array',
              items: {
                type: 'string'
              }
            }
          },
          required: ['context']
        },
        FollowUpQuestionsResponse: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              items: {
                type: 'string'
              }
            }
          }
        },
        ERQuestionsRequest: {
          type: 'object',
          properties: {
            context: {
              type: 'string'
            }
          },
          required: ['context']
        },
        ERQuestionsResponse: {
          type: 'object',
          properties: {
            questions: {
              type: 'array',
              items: {
                type: 'string'
              }
            }
          }
        },
        FollowUpAnswersRequest: {
          type: 'object',
          properties: {
            context: {
              type: 'string'
            },
            answers: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  question: {
                    type: 'string'
                  },
                  answer: {
                    type: 'string'
                  }
                }
              }
            }
          },
          required: ['context', 'answers']
        },
        FollowUpAnswersResponse: {
          type: 'object',
          properties: {
            result: {
              type: 'string'
            }
          }
        },
        SummarizeRequest: {
          type: 'object',
          properties: {
            text: {
              type: 'string'
            },
            maxLength: {
              type: 'integer',
              example: 200
            }
          },
          required: ['text']
        },
        SummarizeResponse: {
          type: 'object',
          properties: {
            summary: {
              type: 'string'
            }
          }
        },
        QueueStatusResponse: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['pending', 'processing', 'completed', 'failed']
            },
            position: {
              type: 'integer'
            },
            estimatedTime: {
              type: 'integer',
              description: 'Estimated time in seconds'
            }
          }
        },
        SystemStatusResponse: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              enum: ['online', 'degraded', 'offline']
            },
            services: {
              type: 'object',
              additionalProperties: {
                type: 'string',
                enum: ['online', 'degraded', 'offline']
              }
            }
          }
        },
        OpinionRequest: {
          type: 'object',
          properties: {
            text: {
              type: 'string'
            }
          },
          required: ['text']
        },
        OpinionResponse: {
          type: 'object',
          properties: {
            sentiment: {
              type: 'string',
              enum: ['positive', 'neutral', 'negative']
            },
            score: {
              type: 'number',
              format: 'float'
            }
          }
        },
        GeneralFeedbackRequest: {
          type: 'object',
          properties: {
            rating: {
              type: 'integer',
              minimum: 1,
              maximum: 5
            },
            comment: {
              type: 'string'
            }
          },
          required: ['rating']
        },
        GeneralFeedbackResponse: {
          type: 'object',
          properties: {
            status: {
              type: 'string',
              example: 'success'
            }
          }
        }
      },
      responses: {
        UnauthorizedError: {
          description: 'Invalid or missing API Key',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: {
                    type: 'string',
                    example: 'Invalid or missing API Key'
                  }
                }
              }
            }
          }
        },
        TooManyRequestsError: {
          description: 'Too many requests',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  error: {
                    type: 'string',
                    example: 'Too many requests, please try again later'
                  }
                }
              }
            }
          }
        }
      }
    }
  },
  apis: ['./routes/*.js'] // Ruta a los archivos con anotaciones
};

// Generar la especificación
const specs = swaggerJsdoc(swaggerOptions);

// Guardar la especificación en un archivo
const targetDir = path.join(__dirname, '../docs');
if (!fs.existsSync(targetDir)) {
  fs.mkdirSync(targetDir, { recursive: true });
}

fs.writeFileSync(
  path.join(targetDir, 'dxgpt-api.yaml'),
  require('yaml').stringify(specs),
  'utf8'
);

console.log('OpenAPI specification has been generated at docs/dxgpt-api.yaml'); 