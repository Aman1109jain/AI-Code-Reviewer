const express = require('express');
const router = express.Router();
const { getReviewById, getFindingsByReview } = require('../../findings/db');

router.get('/reviews/:id/findings', async (req, res) => {
  try {
    const review = await getReviewById(req.params.id);
    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }
    const findings = await getFindingsByReview(req.params.id);
    // The stored source copies (used only for "Create PR") can be large and the
    // detail page doesn't need them — the diff already contains the code.
    const { source_code, source_files, ...reviewForDisplay } = review;
    res.json({ review: reviewForDisplay, findings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
