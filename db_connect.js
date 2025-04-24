'use strict';

const mongoose = require('mongoose');
const config = require('./config');

// Conexión principal
mongoose.connect(config.dbaccounts);

module.exports = mongoose;