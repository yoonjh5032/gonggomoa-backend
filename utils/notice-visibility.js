function normalizeText(value) {
  return String(value || '').trim();
}

function buildVisibilityMeta({
  sourceSystem = '',
  bidMethod = '',
  contractMethod = '',
  detailMethod = '',
} = {}) {
  const source = normalizeText(sourceSystem);
  const bid = normalizeText(bidMethod);
  const contract = normalizeText(contractMethod);
  const detail = normalizeText(detailMethod);
  const normalized = detail || contract || bid || '';

  if (source === 'g2b_api') {
    if (bid === '전자시담') {
      return {
        is_hidden: true,
        hidden_reason: 'g2b_bid_method_전자시담',
        normalized_bid_method: bid,
      };
    }

    if (contract === '수의시담') {
      return {
        is_hidden: true,
        hidden_reason: 'g2b_contract_method_수의시담',
        normalized_bid_method: contract,
      };
    }

    if (detail === '수의시담') {
      return {
        is_hidden: true,
        hidden_reason: 'g2b_detail_method_수의시담',
        normalized_bid_method: detail,
      };
    }
  }

  return {
    is_hidden: false,
    hidden_reason: '',
    normalized_bid_method: normalized,
  };
}

module.exports = {
  buildVisibilityMeta,
};
