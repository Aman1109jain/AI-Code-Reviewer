'use strict';
const express = require('express');
const router = express.Router();
const { getReviewForUser, getFindingsByReview } = require('../../findings/db');
const { requireGithubUser } = require('../../middleware/auth');
const { validate, idParam } = require('../../middleware/validate');
const { HttpError, wrap } = require('../../middleware/errors');

router.get('/reviews/:id/findings', requireGithubUser, validate({ params: idParam }), wrap(async (req, res) => {
  // Scoped to the signed-in user: someone else's review id answers exactly like a missing one.
  const review = await getReviewForUser(req.params.id, req.ghUser.userId);
  if (!review) throw new HttpError(404, 'Review not found');
  const findings = await getFindingsByReview(review.id);
  // The stored source copies (used only for "Create PR") can be large and the detail
  // page doesn't need them - the diff already contains the code.
  const { source_code, source_files, owner_user_id, ...reviewForDisplay } = review;
  res.json({ review: reviewForDisplay, findings });
}));

module.exports = router;
