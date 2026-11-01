'use strict';
const express = require('express');
const router = express.Router();
const { getFindingCountsBySeverity } = require('../../findings/db');
const { requireGithubUser } = require('../../middleware/auth');
const { wrap } = require('../../middleware/errors');

router.get('/analytics/severity', requireGithubUser, wrap(async (req, res) => {
  res.json(await getFindingCountsBySeverity(req.ghUser.userId));
}));

module.exports = router;
