'use strict';
const express = require('express');
const router = express.Router();
const { getReviewsForUser } = require('../../findings/db');
const { requireGithubUser } = require('../../middleware/auth');
const { wrap } = require('../../middleware/errors');

router.get('/reviews', requireGithubUser, wrap(async (req, res) => {
  res.json(await getReviewsForUser(req.ghUser.userId));
}));

module.exports = router;
