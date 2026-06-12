export function renderPipelineSteps(status) {
  const steps = [
    { key: 'capturing_baseline', label: 'Baseline' },
    { key: 'loading_context', label: 'Context' },
    { key: 'scanning_repo', label: 'Scan' },
    { key: 'selecting_files', label: 'Files' },
    { key: 'planning', label: 'Plan' },
    { key: 'editing', label: 'Edit' },
    { key: 'reviewing', label: 'Review' },
    { key: 'finalizing', label: 'Finalize' },
  ];

  let activeIndex = -1;
  let isFailed = false;

  if (status === 'done') {
    activeIndex = steps.length;
  } else if (status.startsWith('failed')) {
    isFailed = true;
    activeIndex = steps.length - 1;
  } else {
    activeIndex = steps.findIndex((s) => s.key === status);
  }

  let html = '';
  steps.forEach((step, i) => {
    let stepClass = '';
    let bubbleContent = i + 1;

    if (i < activeIndex) {
      stepClass = 'passed';
      bubbleContent = '✓';
    } else if (i === activeIndex) {
      if (isFailed) {
        stepClass = 'failed';
        bubbleContent = '✗';
      } else {
        stepClass = 'active';
      }
    }

    html += `
      <div class="pipeline-step ${stepClass}">
        <div class="pipeline-bubble">${bubbleContent}</div>
        <div class="pipeline-step-label">${step.label}</div>
      </div>
    `;
    if (i < steps.length - 1) {
      const connClass =
        i < activeIndex ? 'passed' : i === activeIndex ? 'active' : '';
      html += `<div class="pipeline-connector ${connClass}"></div>`;
    }
  });

  return html;
}
