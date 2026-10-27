function finding(id, title, extra = {}) {
  return {
    id,
    title,
    severity: extra.severity || 'info',
    confidence: extra.confidence || 'high',
    category: extra.category || 'general',
    target: extra.target || '',
    description: extra.description || '',
    impact: extra.impact || '',
    recommendation: extra.recommendation || '',
    evidence: extra.evidence || {},
    requires_root: !!extra.requires_root
  };
}

function requestRecord(method, url, r) {
  return {
    method,
    url,
    status: r.status,
    final_url: r.finalUrl,
    duration_ms: r.durationMs,
    content_type: r.contentType || '',
    response_size: r.bodySize || 0,
    error: r.error || ''
  };
}

module.exports = { finding, requestRecord };
