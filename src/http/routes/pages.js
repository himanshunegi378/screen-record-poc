const express = require('express');
const path = require('path');
const { config } = require('../../config');

/**
 * Express router for client-side pages.
 * @type {express.Router}
 */
const router = express.Router();

/**
 * Wildcard route fallback for frontend SPA routes.
 * Serves the single-page application entry point (index.html) for listed routes.
 */
router.get(['/sandbox', '/recordings', '/recordings/:sessionId'], (req, res) => {
  res.sendFile(path.join(config.publicDir, 'index.html'));
});

module.exports = { pagesRouter: router };

