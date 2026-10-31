const express = require('express');
const router = express.Router();
const { getFindingCountsBySeverity } = require('../../findings/db');

router.get('/analytics/severity', async (req, res) => {
  try {
    const counts = await getFindingCountsBySeverity();
    res.json(counts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
