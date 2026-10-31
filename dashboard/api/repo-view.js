const express = require('express');
const router = express.Router();
const { getAllReviews } = require('../../findings/db');

router.get('/reviews', async (req, res) => {
  try {
    const reviews = await getAllReviews();
    res.json(reviews);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
