export function activeGroups(plan) {
  return plan.groups.map(group => group.filter(name => !(plan.removed ?? []).includes(name))).filter(group => group.length);
}

export function dropStep(original, name, targetIndex, between = false) {
  const groups = activeGroups(original);
  if (!groups.some(group => group.includes(name)) || !Number.isInteger(targetIndex) || targetIndex < 0 || targetIndex > groups.length || (!between && targetIndex === groups.length)) {
    return structuredClone(original);
  }
  // Resolve the destination before removing empty source groups.
  for (const group of groups) {
    const index = group.indexOf(name);
    if (index !== -1) group.splice(index, 1);
  }
  if (between) groups.splice(targetIndex, 0, [name]);
  else groups[targetIndex].push(name);
  return { ...original, groups: groups.filter(group => group.length), policies: { ...original.policies }, removed: [...(original.removed ?? [])], configs: structuredClone(original.configs ?? {}) };
}

export function editPlan(original, name, operation) {
  const plan = { ...original, groups: activeGroups(original), policies: { ...original.policies }, removed: [...(original.removed ?? [])], configs: structuredClone(original.configs ?? {}) };
  const index = plan.groups.findIndex(group => group.includes(name));
  if (operation === 'agent' || operation === 'user' || operation === 'off') {
    plan.policies[name] = operation;
  } else if (operation === 'remove' && index !== -1) {
    plan.groups = plan.groups.map(group => group.filter(step => step !== name)).filter(group => group.length);
    plan.removed.push(name);
  } else if (operation === 'add' && index === -1) {
    plan.removed = plan.removed.filter(step => step !== name);
    plan.policies[name] ??= 'agent';
    plan.groups.push([name]);
  } else if (operation === 'up' && index > 0) {
    [plan.groups[index - 1], plan.groups[index]] = [plan.groups[index], plan.groups[index - 1]];
  } else if (operation === 'down' && index >= 0 && index < plan.groups.length - 1) {
    [plan.groups[index + 1], plan.groups[index]] = [plan.groups[index], plan.groups[index + 1]];
  } else if (operation === 'join' && index > 0) {
    plan.groups[index] = plan.groups[index].filter(step => step !== name);
    plan.groups[index - 1].push(name);
    plan.groups = plan.groups.filter(group => group.length);
  } else if (operation === 'separate' && index >= 0 && plan.groups[index].length > 1) {
    plan.groups[index] = plan.groups[index].filter(step => step !== name);
    plan.groups.splice(index + 1, 0, [name]);
  }
  return plan;
}
