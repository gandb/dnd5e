import { formatNumber, getSceneTargets, getTargetDescriptors, simplifyBonus } from "./utils.mjs";
import Award from "./applications/award.mjs";
import AttackRollConfigurationDialog from "./applications/dice/attack-configuration-dialog.mjs";
import simplifyRollFormula from "./dice/simplify-roll-formula.mjs";
import * as Trait from "./documents/actor/trait.mjs";
import { rollItem } from "./documents/macro.mjs";

const slugify = value => value?.slugify().replaceAll("-", "");

/**
 * Set up custom text enrichers.
 */
export function registerCustomEnrichers() {
  const stringNames = [
    "attack", "award", "check", "concentration", "damage", "healing", "item", "save", "skill", "tool"
  ];
  CONFIG.TextEditor.enrichers.push({
    pattern: new RegExp(`\\[\\[/(?<type>${stringNames.join("|")})(?<config> [^\\]]+)?]](?:{(?<label>[^}]+)})?`, "gi"),
    enricher: enrichString
  },
  {
    pattern: /\[\[(?<type>lookup) (?<config>[^\]]+)]](?:{(?<label>[^}]+)})?/gi,
    enricher: enrichString
  },
  {
    pattern: /&(?<type>Reference)\[(?<config>[^\]]+)](?:{(?<label>[^}]+)})?/gi,
    enricher: enrichString
  });

  document.body.addEventListener("click", applyAction);
  document.body.addEventListener("click", awardAction);
  document.body.addEventListener("click", rollAction);
}

/* -------------------------------------------- */

/**
 * Parse the enriched string and provide the appropriate content.
 * @param {RegExpMatchArray} match       The regular expression match result.
 * @param {EnrichmentOptions} options    Options provided to customize text enrichment.
 * @returns {Promise<HTMLElement|null>}  An HTML element to insert in place of the matched text or null to
 *                                       indicate that no replacement should be made.
 */
async function enrichString(match, options) {
  let { type, config, label } = match.groups;
  config = parseConfig(config, { multiple: ["damage", "healing"].includes(type) });
  config._input = match[0];
  config._rules = _getRulesVersion(options);
  switch ( type.toLowerCase() ) {
    case "attack": return enrichAttack(config, label, options);
    case "award": return enrichAward(config, label, options);
    case "healing": config._isHealing = true;
    case "damage": return enrichDamage(config, label, options);
    case "check":
    case "skill":
    case "tool": return enrichCheck(config, label, options);
    case "lookup": return enrichLookup(config, label, options);
    case "concentration": config._isConcentration = true;
    case "save": return enrichSave(config, label, options);
    case "item": return enrichItem(config, label, options);
    case "reference": return enrichReference(config, label, options);
  }
  return null;
}

/* -------------------------------------------- */

/**
 * Parse a roll string into a configuration object.
 * @param {string} match  Matched configuration string.
 * @param {object} [options={}]
 * @param {boolean} [options.multiple=false]  Support splitting configuration by "&" into multiple sub-configurations.
 *                                            If set to `true` then an array of configs will be returned.
 * @returns {object|object[]}
 */
function parseConfig(match="", { multiple=false }={}) {
  if ( multiple ) return match.split("&").map(s => parseConfig(s));
  const config = { _config: match, values: [] };
  for ( const part of match.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [] ) {
    if ( !part ) continue;
    const [key, value] = part.split("=");
    const valueLower = value?.toLowerCase();
    if ( value === undefined ) config.values.push(key.replace(/(^"|"$)/g, ""));
    else if ( ["true", "false"].includes(valueLower) ) config[key] = valueLower === "true";
    else if ( Number.isNumeric(value) ) config[key] = Number(value);
    else config[key] = value.replace(/(^"|"$)/g, "");
  }
  return config;
}

/* -------------------------------------------- */

/**
 * Determine the appropriate rules version based on the provided document or system setting.
 * @param {EnrichmentOptions} options  Options provided to customize text enrichment.
 * @returns {string}
 */
function _getRulesVersion(options) {
  // Select from actor data first, then item data, and then fall back to system setting
  return options.relativeTo?.parent?.system?.source?.rules
    || options.relativeTo?.system?.source?.rules
    || (game.settings.get("dnd5e", "rulesVersion") === "modern" ? "2024" : "2014");
}

/* -------------------------------------------- */
/*  Attack Enricher                             */
/* -------------------------------------------- */

/**
 * Enrich an attack link using a pre-set to hit value.
 * @param {object} config              Configuration data.
 * @param {string} [label]             Optional label to replace default text.
 * @param {EnrichmentOptions} options  Options provided to customize text enrichment.
 * @returns {HTMLElement|null}         An HTML link if the attack could be built, otherwise null.
 *
 * @example Create an attack link using a fixed to hit:
 * ```[[/attack +5]]``` or ```[[/attack formula=5]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="attack" data-formula="+5">
 *   <i class="fa-solid fa-dice-d20" inert></i> +5
 * </a>
 * ```
 *
 * @example Create an attack link using a specific attack mode:
 * ```[[/attack +5]]``` or ```[[/attack formula=5 attackMode=thrown]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="attack" data-formula="+5" data-attack-mode="thrown">
 *   <i class="fa-solid fa-dice-d20" inert></i> +5
 * </a>
 * ```
 *
 * @example Link an enricher to an attack activity, either explicitly or automatically:
 * ```[[/attack activity=RLQlsLo5InKHZadn]]``` or ```[[/attack]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="attack" data-formula="+8" data-activity-uuid="...uuid...">
 *   <i class="fa-solid fa-dice-d20" inert"></i> +8
 * </a>
 * ```
 *
 * @example Display the full attack section:
 * ```[[/attack format=extended]]``` or ```[[/attack extended]]```
 * becomes
 * ```html
 * <span class="attack-extended">
 *   <em>Melee Attack Roll</em>:
 *   <span class="roll-link-group" data-type="attack" data-formula="+16" data-activity-uuid="...uuid...">
 *     <a class="roll-link"><i class="fa-solid fa-dice-d20" inert"></i> +16</a>
 *   </span>, reach 15 ft
 * </span>
 * ```
 */
async function enrichAttack(config, label, options) {
  if ( config.activity && config.formula ) {
    console.warn(`Activity ID and formula found while enriching ${config._input}, only one is supported.`);
    return null;
  }

  const formulaParts = [];
  if ( config.formula ) formulaParts.push(config.formula);
  for ( const value of config.values ) {
    if ( value in CONFIG.DND5E.attackModes ) config.attackMode = value;
    else if ( value === "extended" ) config.format = "extended";
    else formulaParts.push(value);
  }
  config.formula = Roll.defaultImplementation.replaceFormulaData(formulaParts.join(" "), options.rollData ?? {});

  const activity = config.activity ? options.relativeTo?.system.activities?.get(config.activity)
    : !config.formula ? options.relativeTo?.system.activities?.getByType("attack")[0] : null;

  if ( activity ) {
    config.activityUuid = activity.uuid;
    const attackConfig = activity.getAttackData({ attackMode: config.attackMode });
    config.formula = simplifyRollFormula(
      Roll.defaultImplementation.replaceFormulaData(attackConfig.parts.join(" + "), attackConfig.data)
    );
    delete config.activity;
  }

  if ( !config.activityUuid && !config.formula ) {
    console.warn(`No formula or linked activity found while enriching ${config._input}.`);
    return null;
  }

  config.type = "attack";
  if ( label ) return createRollLink(label, config);

  let displayFormula = simplifyRollFormula(config.formula);
  if ( !displayFormula.startsWith("+") && !displayFormula.startsWith("-") ) displayFormula = `+${displayFormula}`;

  const span = document.createElement("span");
  span.className = "roll-link-group";
  _addDataset(span, config);
  span.innerHTML = game.i18n.format(`EDITOR.DND5E.Inline.Attack${config._rules === "2014" ? "Long" : "Short"}`, {
    formula: createRollLink(displayFormula).outerHTML
  });

  if ( config.format === "extended" ) {
    const type = game.i18n.format(`DND5E.ATTACK.Formatted.${config._rules}`, {
      type: game.i18n.getListFormatter({ type: "disjunction" }).format(
        Array.from(activity?.validAttackTypes ?? []).map(t => CONFIG.DND5E.attackTypes[t]?.label)
      ),
      classification: CONFIG.DND5E.attackClassifications[activity?.attack.type.classification]?.label ?? ""
    }).trim();
    const parts = [span.outerHTML, activity?.getRangeLabel(config.attackMode)];

    // TODO: Add targeting information (e.g. "one target") according to 2014 rules

    const full = document.createElement("span");
    full.className = "attack-extended";
    full.innerHTML = game.i18n.format("EDITOR.DND5E.Inline.AttackExtended", {
      type, parts: game.i18n.getListFormatter({ type: "unit" }).format(parts.filter(_ => _))
    });
    return full;
  }

  return span;
}

/* -------------------------------------------- */
/*  Award Enricher                              */
/* -------------------------------------------- */

/**
 * Enrich an award block displaying amounts for each part granted with a GM-control for awarding to the party.
 * @param {object} config              Configuration data.
 * @param {string} [label]             Optional label to replace default text.
 * @param {EnrichmentOptions} options  Options provided to customize text enrichment.
 * @returns {HTMLElement|null}         An HTML link if the check could be built, otherwise null.
 */
async function enrichAward(config, label, options) {
  const command = config._config;
  let parsed;
  try {
    parsed = Award.parseAwardCommand(command);
  } catch(err) {
    console.warn(err.message);
    return null;
  }

  const block = document.createElement("span");
  block.classList.add("award-block", "dnd5e2");
  block.dataset.awardCommand = command;

  const entries = [];
  for ( let [key, amount] of Object.entries(parsed.currency) ) {
    const label = CONFIG.DND5E.currencies[key].label;
    amount = Number.isNumeric(amount) ? formatNumber(amount) : amount;
    entries.push(`
      <span class="award-entry">
        ${amount} <i class="currency ${key}" data-tooltip="${label}" aria-label="${label}"></i>
      </span>
    `);
  }
  if ( parsed.xp ) entries.push(`
    <span class="award-entry">
      ${formatNumber(parsed.xp)} ${game.i18n.localize("DND5E.ExperiencePointsAbbr")}
    </span>
  `);

  let award = game.i18n.getListFormatter({ type: "unit" }).format(entries);
  if ( parsed.each ) award = game.i18n.format("EDITOR.DND5E.Inline.AwardEach", { award });

  block.innerHTML += `
    ${award}
    <a class="award-link" data-action="awardRequest">
      <i class="fa-solid fa-trophy"></i> ${label ?? game.i18n.localize("DND5E.Award.Action")}
    </a>
  `;

  return block;
}

/* -------------------------------------------- */
/*  Check & Save Enrichers                      */
/* -------------------------------------------- */

/**
 * Enrich an ability check link to perform a specific ability or skill check. If an ability is provided
 * along with a skill, then the skill check will always use the provided ability. Otherwise it will use
 * the character's default ability for that skill.
 * @param {object} config              Configuration data.
 * @param {string} [label]             Optional label to replace default text.
 * @param {EnrichmentOptions} options  Options provided to customize text enrichment.
 * @returns {HTMLElement|null}         An HTML link if the check could be built, otherwise null.
 *
 * @example Create a dexterity check:
 * ```[[/check ability=dex]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="check" data-ability="dex">
 *   <i class="fa-solid fa-dice-d20"></i> Dexterity check
 * </a>
 * ```
 *
 * @example Create an acrobatics check with a DC and default ability:
 * ```[[/check skill=acr dc=20]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="check" data-skill="acr" data-dc="20">
 *   <i class="fa-solid fa-dice-d20"></i> DC 20 Dexterity (Acrobatics) check
 * </a>
 * ```
 *
 * @example Create an acrobatics check using strength:
 * ```[[/check ability=str skill=acr]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="check" data-ability="str" data-skill="acr">
 *   <i class="fa-solid fa-dice-d20"></i> Strength (Acrobatics) check
 * </a>
 * ```
 *
 * @example Create a tool check:
 * ```[[/check tool=thief ability=int]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="check" data-ability="int" data-tool="thief">
 *   <i class="fa-solid fa-dice-d20"></i> Intelligence (Thieves' Tools) check
 * </a>
 * ```
 *
 * @example Formulas used for DCs will be resolved using data provided to the description (not the roller):
 * ```[[/check ability=cha dc=@abilities.int.dc]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="check" data-ability="cha" data-dc="15">
 *   <i class="fa-solid fa-dice-d20"></i> DC 15 Charisma check
 * </a>
 * ```
 */
async function enrichCheck(config, label, options) {
  for ( let value of config.values ) {
    value = foundry.utils.getType(value) === "string" ? slugify(value) : value;
    if ( value in CONFIG.DND5E.enrichmentLookup.abilities ) config.ability = value;
    else if ( value in CONFIG.DND5E.enrichmentLookup.skills ) config.skill = value;
    else if ( value in CONFIG.DND5E.enrichmentLookup.tools ) config.tool = value;
    else if ( Number.isNumeric(value) ) config.dc = Number(value);
    else config[value] = true;
  }

  let invalid = false;

  const skillConfig = CONFIG.DND5E.enrichmentLookup.skills[slugify(config.skill)];
  if ( config.skill && !skillConfig ) {
    console.warn(`Skill ${config.skill} not found while enriching ${config._input}.`);
    invalid = true;
  } else if ( config.skill && !config.ability ) {
    config.ability = skillConfig.ability;
  }
  if ( skillConfig?.key ) config.skill = skillConfig.key;

  const toolConfig = CONFIG.DND5E.tools[slugify(config.tool)];
  const toolUUID = CONFIG.DND5E.enrichmentLookup.tools[slugify(config.tool)];
  const toolIndex = toolUUID ? Trait.getBaseItem(toolUUID, { indexOnly: true }) : null;
  if ( config.tool && !toolIndex ) {
    console.warn(`Tool ${config.tool} not found while enriching ${config._input}.`);
    invalid = true;
  } else if ( config.tool && !config.ability && toolConfig ) {
    config.ability = toolConfig.ability;
  }

  let abilityConfig = CONFIG.DND5E.enrichmentLookup.abilities[slugify(config.ability)];
  if ( config.ability && !abilityConfig ) {
    console.warn(`Ability ${config.ability} not found while enriching ${config._input}.`);
    invalid = true;
  } else if ( !abilityConfig ) {
    console.warn(`No ability provided while enriching check ${config._input}.`);
    invalid = true;
  }
  if ( abilityConfig?.key ) config.ability = abilityConfig.key;

  if ( config.dc && !Number.isNumeric(config.dc) ) config.dc = simplifyBonus(config.dc, options.rollData);

  if ( invalid ) return null;

  const type = config.skill ? "skill" : config.tool ? "tool" : "check";
  config = { type, ...config };
  if ( !label ) label = createRollLabel(config);
  return config.passive ? createPassiveTag(label, config) : createRequestLink(createRollLink(label), config);
}

/* -------------------------------------------- */

/**
 * Enrich a saving throw link.
 * @param {object} config              Configuration data.
 * @param {string} [label]             Optional label to replace default text.
 * @param {EnrichmentOptions} options  Options provided to customize text enrichment.
 * @returns {HTMLElement|null}         An HTML link if the save could be built, otherwise null.
 *
 * @example Create a dexterity saving throw:
 * ```[[/save ability=dex]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="save" data-key="dex">
 *   <i class="fa-solid fa-dice-d20"></i> Dexterity
 * </a>
 * ```
 *
 * @example Add a DC to the save:
 * ```[[/save ability=dex dc=20]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="save" data-key="dex" data-dc="20">
 *   <i class="fa-solid fa-dice-d20"></i> DC 20 Dexterity
 * </a>
 * ```
 *
 * @example Create a concentration check:
 * ```[[/concentration 10]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="concentration" data-dc="10">
 *   <i class="fa-solid fa-dice-d20"></i> DC 10 concentration
 * </a>
 * ```
 */
async function enrichSave(config, label, options) {
  for ( const value of config.values ) {
    if ( value in CONFIG.DND5E.enrichmentLookup.abilities ) config.ability = value;
    else if ( Number.isNumeric(value) ) config.dc = Number(value);
    else config[value] = true;
  }

  const abilityConfig = CONFIG.DND5E.enrichmentLookup.abilities[config.ability];
  if ( !abilityConfig && !config._isConcentration ) {
    console.warn(`Ability ${config.ability} not found while enriching ${config._input}.`);
    return null;
  }
  if ( abilityConfig?.key ) config.ability = abilityConfig.key;

  if ( config.dc && !Number.isNumeric(config.dc) ) config.dc = simplifyBonus(config.dc, options.rollData);

  config = { type: config._isConcentration ? "concentration" : "save", ...config };
  if ( !label ) label = createRollLabel(config);
  return createRequestLink(createRollLink(label), config);
}

/* -------------------------------------------- */
/*  Damage Enricher                             */
/* -------------------------------------------- */

/**
 * Enrich a damage link.
 * @param {object[]} configs           Configuration data.
 * @param {string} [label]             Optional label to replace default text.
 * @param {EnrichmentOptions} options  Options provided to customize text enrichment.
 * @returns {HTMLElement|null}         An HTML link if the save could be built, otherwise null.
 *
 * @example Create a damage link:
 * ```[[/damage 2d6 type=bludgeoning]]``
 * becomes
 * ```html
 * <a class="roll-link-group" data-type="damage" data-formulas="2d6" data-damage-types="bludgeoning">
 *   <span class="roll-link"><i class="fa-solid fa-dice-d20"></i> 2d6</span> bludgeoning
 * </a>
 * ````
 *
 * @example Display the average:
 * ```[[/damage 2d6 type=bludgeoning average=true]]``
 * becomes
 * ```html
 * 7 (<a class="roll-link-group" data-type="damage" data-formulas="2d6" data-damage-types="bludgeoning">
 *   <span class="roll-link"><i class="fa-solid fa-dice-d20"></i> 2d6</span>
 * </a>) bludgeoning
 * ````
 *
 * @example Manually set the average & don't prefix the type:
 * ```[[/damage 8d4dl force average=666]]``
 * becomes
 * ```html
 * 666 (<a class="roll-link-group" data-type="damage" data-formulas="8d4dl" data-damage-types="force">
 *   <span class="roll-link"><i class="fa-solid fa-dice-d20"></i> 8d4dl</span>
 * </a> force
 * ````
 *
 * @example Create a healing link:
 * ```[[/healing 2d6]]``` or ```[[/damage 2d6 healing]]```
 * becomes
 * ```html
 * <a class="roll-link-group" data-type="damage" data-formulas="2d6" data-damage-types="healing">
 *   <span class="roll-link"><i class="fa-solid fa-dice-d20"></i> 2d6</span>
 * </a> healing
 * ```
 *
 * @example Specify variable damage types:
 * ```[[/damage 2d6 type=fire|cold]]``` or ```[[/damage 2d6 type=fire/cold]]```
 * becomes
 * ```html
 * <a class="roll-link-group" data-type="damage" data-formulas="2d6" data-damage-types="fire|cold">
 *   <span class="roll-link"><i class="fa-solid fa-dice-d20"></i> 2d6</span>
 * </a> fire or cold
 * ```
 *
 * @example Add multiple damage parts
 * ```[[/damage 1d6 fire & 1d6 cold]]```
 * becomes
 * ```html
 * <a class="roll-link-group" data-type="damage" data-formulas="1d6&1d6" data-damage-types="fire&cold">
 *   <span class="roll-link"><i class="fa-solid fa-dice-d20"></i> 1d6</span> fire and
 *   <span class="roll-link"><i class="fa-solid fa-dice-d20"></i> 1d6</span> cold
 * </a>
 * ```
 *
 * @example Link an enricher to an damage activity, either explicitly or automatically
 * ```[[/damage activity=RLQlsLo5InKHZadn]]``` or ```[[/damage]]```
 * becomes
 * ```html
 * <a class="roll-link-group" data-type="damage" data-formulas="1d6&1d6" data-damage-types="fire&cold"
 *    data-activity-uuid="...">
 *   <span class="roll-link"><i class="fa-solid fa-dice-d20"></i> 1d6</span> fire and
 *   <span class="roll-link"><i class="fa-solid fa-dice-d20"></i> 1d6</span> cold
 * </a>
 * ```
 *
 * @example Displaying the full hit section:
 * ```[[/damage extended]]``
 * becomes
 * ```html
 * <span class="damage-extended">
 *   <em>Hit:</em>
 *   <a class="roll-link-group" data-type="damage" data-formulas="2d6" data-damage-types="bludgeoning"
 *      data-activity-uuid="...">
 *     7 (<span class="roll-link"><i class="fa-solid fa-dice-d20"></i> 2d6</span></a>) Bludgeoning damage
 *   </a>
 * </span>
 * ````
 */
async function enrichDamage(configs, label, options) {
  const config = { type: "damage", formulas: [], damageTypes: [], rollType: configs._isHealing ? "healing" : "damage" };
  for ( const c of configs ) {
    const formulaParts = [];
    if ( c.average ) config.average = c.average;
    if ( c.format ) config.format = c.format;
    if ( c.formula ) formulaParts.push(c.formula);
    for ( const value of c.values ) {
      if ( value in CONFIG.DND5E.damageTypes ) c.type = value;
      else if ( value in CONFIG.DND5E.healingTypes ) c.type = value;
      else if ( value in CONFIG.DND5E.attackModes ) config.attackMode = value;
      else if ( value === "average" ) config.average = true;
      else if ( value === "extended" ) config.format = "extended";
      else if ( value === "temp" ) c.type = "temphp";
      else formulaParts.push(value);
    }
    c.formula = Roll.defaultImplementation.replaceFormulaData(formulaParts.join(" "), options.rollData ?? {});
    c.type ??= configs._isHealing ? "healing" : null;
    if ( c.formula ) {
      config.formulas.push(c.formula);
      config.damageTypes.push(c.type);
    }
  }
  config.damageTypes = config.damageTypes.map(t => t?.replace("/", "|"));
  if ( config.format === "extended" ) config.average ??= true;

  if ( config.activity && config.formulas.length ) {
    console.warn(`Activity ID and formulas found while enriching ${config._input}, only one is supported.`);
    return null;
  }

  let activity = options.relativeTo?.system.activities?.get(config.activity);
  if ( !activity && !config.formula ) {
    for ( const a of options.relativeTo?.system.activities?.getByTypes("attack", "damage", "save") ?? [] ) {
      if ( a.damage.parts.length ) {
        activity = a;
        break;
      }
    }
  }

  if ( activity ) {
    config.activityUuid = activity.uuid;
    const damageConfig = activity.getDamageConfig({ attackMode: config.attackMode });
    for ( const roll of damageConfig.rolls ) {
      config.formulas.push(simplifyRollFormula(
        Roll.defaultImplementation.replaceFormulaData(roll.parts.join(" + "), roll.data)
      ));
      config.damageTypes.push(roll.options.types?.join("|") ?? roll.options.type);
    }
    delete config.activity;
  }

  if ( !config.activityUuid && !config.formulas.length ) {
    console.warn(`No formula or linked activity found while enriching ${config._input}.`);
    return null;
  }

  const formulas = config.formulas.join("&");
  const damageTypes = config.damageTypes.join("&");

  if ( !config.formulas.length ) return null;
  if ( label ) return createRollLink(label, { ...config, formulas, damageTypes });

  const parts = [];
  for ( const [idx, formula] of config.formulas.entries() ) {
    const type = config.damageTypes[idx];
    const types = type?.split("|")
      .map(t => CONFIG.DND5E.damageTypes[t]?.label ?? CONFIG.DND5E.healingTypes[t]?.label)
      .filter(_ => _);
    const localizationData = {
      formula: createRollLink(formula, {}, { tag: "span" }).outerHTML,
      type: game.i18n.getListFormatter({ type: "disjunction" }).format(types)
    };
    if ( configs._rules === "2014" ) localizationData.type = localizationData.type.toLowerCase();

    let localizationType = "Short";
    if ( config.average ) {
      localizationType = "Long";
      if ( config.average === true ) {
        const minRoll = Roll.create(formula).evaluate({ minimize: true });
        const maxRoll = Roll.create(formula).evaluate({ maximize: true });
        localizationData.average = Math.floor(((await minRoll).total + (await maxRoll).total) / 2);
      } else if ( Number.isNumeric(config.average) ) {
        localizationData.average = config.average;
      } else {
        localizationType = "Short";
      }
    }

    parts.push(game.i18n.format(`EDITOR.DND5E.Inline.Damage${localizationType}`, localizationData));
  }

  const link = document.createElement("a");
  link.className = "roll-link-group";
  _addDataset(link, { ...config, formulas, damageTypes });
  if ( config.average && (parts.length === 2) ) {
    link.innerHTML = game.i18n.format("EDITOR.DND5E.Inline.DamageDouble", { first: parts[0], second: parts[1] });
  } else {
    link.innerHTML = game.i18n.getListFormatter().format(parts);
  }

  if ( config.format === "extended" ) {
    const span = document.createElement("span");
    span.className = "damage-extended";
    span.innerHTML = game.i18n.format("EDITOR.DND5E.Inline.DamageExtended", { damage: link.outerHTML });
    return span;
  }

  return link;
}

/* -------------------------------------------- */
/*  Lookup Enricher                             */
/* -------------------------------------------- */

/**
 * Enrich a property lookup.
 * @param {object} config              Configuration data.
 * @param {string} [fallback]          Optional fallback if the value couldn't be found.
 * @param {EnrichmentOptions} options  Options provided to customize text enrichment.
 * @returns {HTMLElement|null}         An HTML element if the lookup could be built, otherwise null.
 *
 * @example Include a creature's name in its description:
 * ```[[lookup @name]]``
 * becomes
 * ```html
 * <span class="lookup-value">Adult Black Dragon</span>
 * ```
 */
function enrichLookup(config, fallback, options) {
  let keyPath = config.path;
  let style = config.style;
  for ( const value of config.values ) {
    if ( value === "capitalize" ) style ??= "capitalize";
    else if ( value === "lowercase" ) style ??= "lowercase";
    else if ( value === "uppercase" ) style ??= "uppercase";
    else if ( value.startsWith("@") ) keyPath ??= value;
  }

  if ( !keyPath ) {
    console.warn(`Lookup path must be defined to enrich ${config._input}.`);
    return null;
  }

  const data = options.rollData ?? options.relativeTo?.getRollData();
  let value = foundry.utils.getProperty(data, keyPath.substring(1)) ?? fallback;
  if ( value && style ) {
    if ( style === "capitalize" ) value = value.capitalize();
    else if ( style === "lowercase" ) value = value.toLowerCase();
    else if ( style === "uppercase" ) value = value.toUpperCase();
  }

  const span = document.createElement("span");
  span.classList.add("lookup-value");
  if ( !value && (options.documents === false) ) return null;
  if ( !value ) span.classList.add("not-found");
  span.innerText = value ?? keyPath;
  return span;
}

/* -------------------------------------------- */
/*  Reference Enricher                          */
/* -------------------------------------------- */

/**
 * Enrich a reference link.
 * @param {object} config              Configuration data.
 * @param {string} [label]             Optional label to replace default text.
 * @param {EnrichmentOptions} options  Options provided to customize text enrichment.
 * @returns {HTMLElement|null}         An HTML link to the Journal Entry Page for the given reference.
 *
 * @example Create a content link to the relevant reference:
 * ```&Reference[condition=unconscious]{Label}```
 * becomes
 * ```html
 * <span class="reference-link">
 *   <a class="content-link" draggable="true"
 *      data-uuid="Compendium.dnd5e.rules.JournalEntry.w7eitkpD7QQTB6j0.JournalEntryPage.UWw13ISmMxDzmwbd"
 *      data-type="JournalEntryPage" data-tooltip="Text Page">
 *     <i class="fas fa-book-open"></i> Label
 *   </a>
 *   <a class="enricher-action" data-action="apply" data-status="unconscious"
 *      data-tooltip="EDITOR.DND5E.Inline.ApplyStatus" aria-label="Apply Status to Selected Tokens">
 *     <i class="fas fa-fw fa-reply-all fa-flip-horizontal"></i>
 *   </a>
 * </span>
 * ```
 */
async function enrichReference(config, label, options) {
  let key;
  let source;
  let isCondition = "condition" in config;
  const type = Object.keys(config).find(k => k in CONFIG.DND5E.ruleTypes);
  if ( type ) {
    key = slugify(config[type]);
    source = foundry.utils.getProperty(CONFIG.DND5E, CONFIG.DND5E.ruleTypes[type].references)?.[key];
  } else if ( config.values.length ) {
    key = slugify(config.values.join(""));
    for ( const [type, { references }] of Object.entries(CONFIG.DND5E.ruleTypes) ) {
      source = foundry.utils.getProperty(CONFIG.DND5E, references)[key];
      if ( source ) {
        if ( type === "condition" ) isCondition = true;
        break;
      }
    }
  }
  if ( !source ) {
    console.warn(`No valid rule found while enriching ${config._input}.`);
    return null;
  }
  const uuid = foundry.utils.getType(source) === "Object" ? source.reference : source;
  if ( !uuid ) return null;
  const doc = await fromUuid(uuid);
  const span = document.createElement("span");
  span.classList.add("reference-link");
  span.append(doc.toAnchor({ name: label || doc.name }));
  if ( isCondition && (config.apply !== false) ) {
    const apply = document.createElement("a");
    apply.classList.add("enricher-action");
    apply.dataset.action = "apply";
    apply.dataset.status = key;
    apply.dataset.tooltip = "EDITOR.DND5E.Inline.ApplyStatus";
    apply.setAttribute("aria-label", game.i18n.localize(apply.dataset.tooltip));
    apply.innerHTML = '<i class="fas fa-fw fa-reply-all fa-flip-horizontal"></i>';
    span.append(apply);
  }
  return span;
}

/* -------------------------------------------- */
/*  Helpers                                     */
/* -------------------------------------------- */

/**
 * Enrich an item use link to roll an item on the selected token.
 * @param {string[]} config              Configuration data.
 * @param {string} [label]               Optional label to replace default text.
 * @param {EnrichmentOptions} options  Options provided to customize text enrichment.
 * @returns {Promise<HTMLElement|null>}  An HTML link if the item link could be built, otherwise null.
 *
 * @example Use an Item from a name:
 * ```[[/item Heavy Crossbow]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="item" data-roll-item-name="Heavy Crossbow">
 *   <i class="fa-solid fa-dice-d20"></i> Heavy Crossbow
 * </a>
 * ```
 *
 * @example Use an Item from a UUID:
 * ```[[/item Actor.M4eX4Mu5IHCr3TMf.Item.amUUCouL69OK1GZU]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="item" data-roll-item-uuid="Actor.M4eX4Mu5IHCr3TMf.Item.amUUCouL69OK1GZU">
 *   <i class="fa-solid fa-dice-d20"></i> Bite
 * </a>
 * ```
 *
 * @example Use an Item from an ID:
 * ```[[/item amUUCouL69OK1GZU]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="item" data-roll-item-uuid="Actor.M4eX4Mu5IHCr3TMf.Item.amUUCouL69OK1GZU">
 *   <i class="fa-solid fa-dice-d20"></i> Bite
 * </a>
 * ```
 *
 * @example Use an Activity on an Item from a name:
 * ```[[/item Heavy Crossbow activity=Poison]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="item" data-roll-item-name="Heavy Crossbow" data-roll-activity-name="Poison">
 *   <i class="fa-solid fa-dice-d20"></i> Heavy Crossbow: Poison
 * </a>
 * ```
 *
 * @example Use an Activity on an Item:
 * ```[[/item amUUCouL69OK1GZU activity=G8ng63Tjqy5W52OP]]```
 * becomes
 * ```html
 * <a class="roll-action" data-type="item"
 *    data-roll-activity-uuid="Actor.M4eX4Mu5IHCr3TMf.Item.amUUCouL69OK1GZU.Activity.G8ng63Tjqy5W52OP">
 *   <i class="fa-solid fa-dice-d20"></i> Bite: Save
 * </a>
 * ```
 */
async function enrichItem(config, label, options) {
  const givenItem = config.values.join(" ");
  // If config is a UUID
  const itemUuidMatch = givenItem.match(
    /^(?<synthid>Scene\.\w{16}\.Token\.\w{16}\.)?(?<actorid>Actor\.\w{16})(?<itemid>\.?Item(?<relativeId>\.\w{16}))$/
  );
  if ( itemUuidMatch ) {
    const ownerActor = itemUuidMatch.groups.actorid.trim();
    if ( !label ) {
      const item = await fromUuid(givenItem);
      if ( !item ) {
        console.warn(`Item not found while enriching ${config._input}.`);
        return null;
      }
      label = item.name;
    }
    return createRollLink(label, { type: "item", rollItemActor: ownerActor, rollItemUuid: givenItem });
  }

  let foundItem;
  const foundActor = options.relativeTo instanceof Item
    ? options.relativeTo.parent
    : options.relativeTo instanceof Actor ? options.relativeTo : null;

  // If config is an Item ID
  if ( /^\w{16}$/.test(givenItem) && foundActor ) foundItem = foundActor.items.get(givenItem);

  // If config is a relative UUID
  if ( givenItem.startsWith(".") ) {
    try {
      foundItem = await fromUuid(givenItem, { relative: options.relativeTo });
    } catch(err) { return null; }
  }

  const makeLink = (label, dataset) => {
    const span = document.createElement("span");
    span.classList.add("roll-link-group");
    _addDataset(span, dataset);
    span.append(createRollLink(label));
    return span;
  };

  if ( foundItem ) {
    let foundActivity;
    if ( config.activity ) {
      foundActivity = foundItem.system.activities?.get(config.activity)
        ?? foundItem.system.activities?.getName(config.activity);
      if ( !foundActivity ) {
        console.warn(`Activity ${config.activity} not found on ${foundItem.name} while enriching ${config._input}.`);
        return null;
      }
      if ( !label ) label = `${foundItem.name}: ${foundActivity.name}`;
      return makeLink(label, { type: "item", rollActivityUuid: foundActivity.uuid });
    }

    if ( !label ) label = foundItem.name;
    return makeLink(label, { type: "item", rollItemUuid: foundItem.uuid });
  }

  // Finally, if config is an item name
  if ( !label ) label = config.activity ? `${givenItem}: ${config.activity}` : givenItem;
  return makeLink(label, {
    type: "item", rollItemActor: foundActor?.uuid, rollItemName: givenItem, rollActivityName: config.activity
  });
}

/* -------------------------------------------- */

/**
 * Add a dataset object to the provided element.
 * @param {HTMLElement} element  Element to modify.
 * @param {object} dataset       Data properties to add.
 * @private
 */
function _addDataset(element, dataset) {
  for ( const [key, value] of Object.entries(dataset) ) {
    if ( !key.startsWith("_") && (key !== "values") && value ) element.dataset[key] = value;
  }
}

/* -------------------------------------------- */

/**
 * Create a passive skill tag.
 * @param {string} label    Label to display.
 * @param {object} dataset  Data that will be added to the tag.
 * @returns {HTMLElement}
 */
function createPassiveTag(label, dataset) {
  const span = document.createElement("span");
  span.classList.add("passive-check");
  _addDataset(span, {
    ...dataset,
    tooltip: `
      <section class="loading" data-passive><i class="fas fa-spinner fa-spin-pulse"></i></section>
    `
  });
  span.innerText = label;
  return span;
}

/* -------------------------------------------- */

/**
 * Create a label for a roll message.
 * @param {object} config  Configuration data.
 * @returns {string}
 */
export function createRollLabel(config) {
  const { label: ability, abbreviation } = CONFIG.DND5E.abilities[config.ability] ?? {};
  const skill = CONFIG.DND5E.skills[config.skill]?.label;
  const toolUUID = CONFIG.DND5E.enrichmentLookup.tools[config.tool];
  const tool = toolUUID ? Trait.getBaseItem(toolUUID, { indexOnly: true })?.name : null;
  const longSuffix = config.format === "long" ? "Long" : "Short";
  const showDC = config.dc && !config.hideDC;

  let label;
  switch ( config.type ) {
    case "check":
    case "skill":
    case "tool":
      if ( ability && (skill || tool) ) {
        label = game.i18n.format("EDITOR.DND5E.Inline.SpecificCheck", { ability, type: skill ?? tool });
      } else {
        label = ability;
      }
      if ( config.passive ) {
        label = game.i18n.format(`EDITOR.DND5E.Inline.DCPassive${longSuffix}`, { dc: config.dc, check: label });
      } else {
        if ( showDC ) label = game.i18n.format("EDITOR.DND5E.Inline.DC", { dc: config.dc, check: label });
        label = game.i18n.format(`EDITOR.DND5E.Inline.Check${longSuffix}`, { check: label });
      }
      break;
    case "concentration":
    case "save":
      if ( config.type === "save" ) label = ability;
      else label = `${game.i18n.localize("DND5E.Concentration")} ${ability ? `(${abbreviation})` : ""}`;
      if ( showDC ) label = game.i18n.format("EDITOR.DND5E.Inline.DC", { dc: config.dc, check: label });
      label = game.i18n.format(`EDITOR.DND5E.Inline.Save${longSuffix}`, { save: label });
      break;
    default:
      return "";
  }

  if ( config.icon ) {
    switch ( config.type ) {
      case "check":
      case "skill":
        label = `<i class="dnd5e-icon" data-src="systems/dnd5e/icons/svg/ability-score-improvement.svg"></i>${label}`;
        break;
      case "tool":
        label = `<i class="fas fa-hammer"></i>${label}`;
        break;
      case "concentration":
      case "save":
        label = `<i class="fas fa-shield-heart"></i>${label}`;
        break;
    }
  }

  return label;
}

/* -------------------------------------------- */

/**
 * Create a rollable link with a request section for GMs.
 * @param {HTMLElement|string} label  Label to display
 * @param {object} dataset            Data that will be added to the link for the rolling method.
 * @returns {HTMLElement}
 */
function createRequestLink(label, dataset) {
  const span = document.createElement("span");
  span.classList.add("roll-link-group");
  _addDataset(span, dataset);
  if ( label instanceof HTMLElement ) span.insertAdjacentElement("afterbegin", label);
  else span.append(label);

  // Add chat request link for GMs
  if ( game.user.isGM ) {
    const gmLink = document.createElement("a");
    gmLink.classList.add("enricher-action");
    gmLink.dataset.action = "request";
    gmLink.dataset.tooltip = "EDITOR.DND5E.Inline.RequestRoll";
    gmLink.setAttribute("aria-label", game.i18n.localize(gmLink.dataset.tooltip));
    gmLink.insertAdjacentHTML("afterbegin", '<i class="fa-solid fa-comment-dots"></i>');
    span.insertAdjacentElement("beforeend", gmLink);
  }

  return span;
}

/* -------------------------------------------- */

/**
 * Create a rollable link.
 * @param {string} label                           Label to display.
 * @param {object} [dataset={}]                    Data that will be added to the link for the rolling method.
 * @param {object} [options={}]
 * @param {boolean} [options.classes="roll-link"]  Class to add to the link.
 * @param {string} [options.tag="a"]               Tag to use for the main link.
 * @returns {HTMLElement}
 */
function createRollLink(label, dataset={}, { classes="roll-link", tag="a" }={}) {
  const link = document.createElement(tag);
  link.className = classes;
  link.insertAdjacentHTML("afterbegin", '<i class="fa-solid fa-dice-d20" inert></i>');
  link.append(label);
  _addDataset(link, dataset);
  return link;
}

/* -------------------------------------------- */
/*  Actions                                     */
/* -------------------------------------------- */

/**
 * Toggle status effects on selected tokens.
 * @param {PointerEvent} event  The triggering event.
 * @returns {Promise<void>}
 */
async function applyAction(event) {
  const target = event.target.closest('[data-action="apply"][data-status]');
  const status = target?.dataset.status;
  if ( !status ) return;
  event.stopPropagation();
  const actors = new Set();
  for ( const { actor } of canvas.tokens.controlled ) {
    if ( !actor || actors.has(actor) ) continue;
    await actor.toggleStatusEffect(status);
    actors.add(actor);
  }
}

/* -------------------------------------------- */

/**
 * Forward clicks on award requests to the Award application.
 * @param {Event} event  The click event triggering the action.
 * @returns {Promise<void>}
 */
async function awardAction(event) {
  const target = event.target.closest('[data-action="awardRequest"]');
  const command = target?.closest("[data-award-command]")?.dataset.awardCommand;
  if ( !command ) return;
  event.stopPropagation();
  Award.handleAward(command);
}

/* -------------------------------------------- */

/**
 * Perform the provided roll action.
 * @param {Event} event  The click event triggering the action.
 * @returns {Promise}
 */
async function rollAction(event) {
  const target = event.target.closest('.roll-link-group, [data-action="rollRequest"], [data-action="concentration"]');
  if ( !target ) return;
  event.stopPropagation();

  const { type, ability, skill, tool, dc } = target.dataset;
  const options = { event };
  if ( ability in CONFIG.DND5E.abilities ) options.ability = ability;
  if ( dc ) options.target = dc;

  const action = event.target.closest("a")?.dataset.action ?? "roll";

  // Direct roll
  if ( (action === "roll") || !game.user.isGM ) {
    target.disabled = true;
    try {
      switch ( type ) {
        case "attack": return await rollAttack(event);
        case "damage": return await rollDamage(event);
        case "item": return await useItem(target.dataset);
      }

      const actors = getSceneTargets().map(t => t.actor);
      if ( !actors.length && game.user.character ) actors.push(game.user.character);
      if ( !actors.length ) {
        ui.notifications.warn("EDITOR.DND5E.Inline.Warning.NoActor", { localize: true });
        return;
      }

      for ( const actor of actors ) {
        switch ( type ) {
          case "check":
            await actor.rollAbilityCheck(options);
            break;
          case "concentration":
            await actor.rollConcentration({ ...options, legacy: false });
            break;
          case "save":
            await actor.rollSavingThrow(options);
            break;
          case "skill":
            await actor.rollSkill({ skill, ...options });
            break;
          case "tool":
            await actor.rollToolCheck({ tool, ...options });
            break;
        }
      }
    } finally {
      target.disabled = false;
    }
  }

  // Roll request
  else {
    const MessageClass = getDocumentClass("ChatMessage");
    const chatData = {
      user: game.user.id,
      content: await renderTemplate("systems/dnd5e/templates/chat/request-card.hbs", {
        buttonLabel: createRollLabel({ ...target.dataset, format: "short", icon: true }),
        hiddenLabel: createRollLabel({ ...target.dataset, format: "short", icon: true, hideDC: true }),
        dataset: { ...target.dataset, action: "rollRequest", visibility: "all" }
      }),
      flavor: game.i18n.localize("EDITOR.DND5E.Inline.RollRequest"),
      speaker: MessageClass.getSpeaker({user: game.user})
    };
    return MessageClass.create(chatData);
  }
}

/* -------------------------------------------- */

/**
 * Perform an attack roll.
 * @param {Event} event     The click event triggering the action.
 * @returns {Promise|void}
 */
async function rollAttack(event) {
  const target = event.target.closest(".roll-link-group");
  const { activityUuid, attackMode, formula } = target.dataset;

  if ( activityUuid ) {
    const activity = await fromUuid(activityUuid);
    if ( activity ) return activity.rollAttack({ attackMode, event });
  }

  const targets = getTargetDescriptors();
  const rollConfig = {
    attackMode, event,
    hookNames: ["attack", "d20Test"],
    rolls: [{
      parts: [formula.replace(/^\s*\+\s*/, "")],
      options: {
        target: targets.length === 1 ? targets[0].ac : undefined
      }
    }]
  };

  const dialogConfig = {
    applicationClass: AttackRollConfigurationDialog
  };

  const messageConfig = {
    data: {
      flags: {
        dnd5e: {
          messageType: "roll",
          roll: { type: "attack" }
        }
      },
      flavor: game.i18n.localize("DND5E.AttackRoll"),
      speaker: ChatMessage.implementation.getSpeaker()
    }
  };

  const rolls = await CONFIG.Dice.D20Roll.build(rollConfig, dialogConfig, messageConfig);
  if ( rolls?.length ) {
    Hooks.callAll("dnd5e.rollAttackV2", rolls, { subject: null, ammoUpdate: null });
    Hooks.callAll("dnd5e.postRollAttack", rolls, { subject: null });
  }
}

/* -------------------------------------------- */

/**
 * Perform a damage roll.
 * @param {Event} event  The click event triggering the action.
 * @returns {Promise<void>}
 */
async function rollDamage(event) {
  const target = event.target.closest(".roll-link-group");
  let { activityUuid, attackMode, formulas, damageTypes, rollType } = target.dataset;

  if ( activityUuid ) {
    const activity = await fromUuid(activityUuid);
    if ( activity ) return activity.rollDamage({ attackMode, event });
  }

  formulas = formulas?.split("&") ?? [];
  damageTypes = damageTypes?.split("&") ?? [];

  const rollConfig = {
    attackMode, event,
    hookNames: ["damage"],
    rolls: formulas.map((formula, idx) => {
      const types = damageTypes[idx]?.split("|") ?? [];
      return {
        parts: [formula],
        options: { type: types[0], types }
      };
    })
  };

  const messageConfig = {
    create: true,
    data: {
      flags: {
        dnd5e: {
          messageType: "roll",
          roll: { type: rollType },
          targets: getTargetDescriptors()
        }
      },
      flavor: game.i18n.localize(`DND5E.${rollType === "healing" ? "Healing" : "Damage"}Roll`),
      speaker: ChatMessage.implementation.getSpeaker()
    }
  };

  const rolls = await CONFIG.Dice.DamageRoll.build(rollConfig, {}, messageConfig);
  if ( !rolls?.length ) return;
  Hooks.callAll("dnd5e.rollDamageV2", rolls);
}

/* -------------------------------------------- */

/**
 * Use an Item from an Item enricher.
 * @param {object} [options]
 * @param {string} [options.rollActivityUuid]  Lookup the Activity by UUID.
 * @param {string} [options.rollActivityName]  Lookup the Activity by name.
 * @param {string} [options.rollItemUuid]      Lookup the Item by UUID.
 * @param {string} [options.rollItemName]      Lookup the Item by name.
 * @param {string} [options.rollItemActor]     The UUID of a specific Actor that should use the Item.
 * @returns {Promise}
 */
async function useItem({ rollActivityUuid, rollActivityName, rollItemUuid, rollItemName, rollItemActor }={}) {
  // If UUID is provided, always roll that item directly
  if ( rollActivityUuid ) return (await fromUuid(rollActivityUuid))?.use();
  if ( rollItemUuid ) return (await fromUuid(rollItemUuid))?.use({ legacy: false });

  if ( !rollItemName ) return;
  const actor = rollItemActor ? await fromUuid(rollItemActor) : null;

  // If no actor is specified or player isn't owner, fall back to the macro rolling logic
  if ( !actor?.isOwner ) return rollItem(rollItemName, { activityName: rollActivityName });
  const token = canvas.tokens.controlled[0];

  // If a token is controlled, and it has an item with the correct name, activate it
  let item = token?.actor.items.getName(rollItemName);

  // Otherwise check the specified actor for the item
  if ( !item ) {
    item = actor.items.getName(rollItemName);

    // Display a warning to indicate the item wasn't rolled from the controlled actor
    if ( item && canvas.tokens.controlled.length ) ui.notifications.warn(
      game.i18n.format("MACRO.5eMissingTargetWarn", {
        actor: token.name, name: rollItemName, type: game.i18n.localize("DOCUMENT.Item")
      })
    );
  }

  if ( item ) {
    if ( rollActivityName ) {
      const activity = item.system.activities?.getName(rollActivityName);
      if ( activity ) return activity.use();

      // If no activity could be found at all, display a warning
      else ui.notifications.warn(game.i18n.format("EDITOR.DND5E.Inline.Warning.NoActivityOnItem", {
        activity: rollActivityName, actor: actor.name, item: rollItemName
      }));
    }

    else return item.use({ legacy: false });
  }

  // If no item could be found at all, display a warning
  else ui.notifications.warn(game.i18n.format("EDITOR.DND5E.Inline.Warning.NoItemOnActor", {
    actor: actor.name, item: rollItemName
  }));
}
