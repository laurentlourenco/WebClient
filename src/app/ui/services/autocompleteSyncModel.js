import _ from 'lodash';

import { REGEX_EMAIL } from '../../constants';
import extendPGP from '../../../helpers/composerIconHelper';

/* @ngInject */
function autocompleteSyncModel(sendPreferences, autoPinPrimaryKeys, checkTypoEmails, keyCache) {
    /**
     * Handle the missing primary keys.
     * @param preferencesMap
     * @returns {Promise<Array>}
     */
    const handleMissingPrimaryKeys = async (preferencesMap) => {
        if (!_.some(_.map(preferencesMap, 'primaryPinned'), (b) => !b)) {
            return [];
        }

        const pairs = _.toPairs(preferencesMap);
        const missingPrimaryKeys = pairs.filter(([, { primaryPinned }]) => !primaryPinned).map(([adr]) => adr);
        const pinned = await autoPinPrimaryKeys.confirm(missingPrimaryKeys);

        if (pinned) {
            // fixed automatically
            return [];
        }

        return missingPrimaryKeys;
    };

    /**
     * Handle the invalid signatures.
     * @param {Object} preferencesMap
     * @returns {Promise<Array>}
     */
    const handleInvalidSigs = async (preferencesMap) => {
        if (!_.some(_.map(preferencesMap, 'isVerified'), (b) => !b)) {
            return [];
        }

        const pairs = _.toPairs(preferencesMap);
        const invalidSigs = pairs.filter(([, { isVerified }]) => !isVerified).map(([adr]) => adr);
        const resigned = await autoPinPrimaryKeys.resign(invalidSigs);

        if (resigned) {
            // fixed automatically
            return [];
        }

        return invalidSigs;
    };

    /**
     * Create a recipient extender that extends recipients with extra information, e.g. PGP and invalid.
     * Keeps a cache with the information. Dependant on the message.
     * @param {Message} message
     */
    return (message) => {
        /**
         * Cache keeping information about email addresses and encryption information.
         * @type {{[email]: {Address,Name,...PGPInfo}}}
         */
        const CACHE = {};

        /**
         * Extend the recipients.
         * If the address does not already exist, set loading to true. Otherwise extend with the cached information.
         * @param {Array} list
         * @returns {any[]}
         */
        const extendFromCache = (list = []) => {
            return list.map((email = {}) => {
                const { Address } = email;
                const cached = CACHE[Address];
                if (!cached) {
                    return {
                        ...email,
                        loadCryptInfo: true
                    };
                }
                return {
                    ...cached,
                    ...email
                };
            });
        };

        /**
         * Extend an email with information if it is invalid.
         * @param {String} email
         * @returns {Promise<{invalid: (boolean|*)}>}
         */
        const extendInvalid = async (email) => {
            const { Address } = email;
            return {
                ...email,
                invalid: !REGEX_EMAIL.test(Address) || checkTypoEmails(Address) || (await keyCache.isInvalid(Address))
            };
        };

        /**
         * Prompt the user to fix any recipients with invalid signatures or missing primary keys.
         * If the user does not, return them as broken.
         * @param {Object} sendPreferencesMap
         * @returns {Promise<Array>}
         */
        const handleInvalid = async (sendPreferencesMap) => {
            const invalidSigs = await handleInvalidSigs(sendPreferencesMap);
            const missingPrimaryKeys = await handleMissingPrimaryKeys(sendPreferencesMap);
            return invalidSigs.concat(missingPrimaryKeys);
        };

        /**
         * Extend emails with PGP information.
         * @param {Array} emails
         * @param {Object} sendPreferencesMap
         * @returns {Promise}
         */
        const extendAsync = (emails = [], sendPreferencesMap = {}) => {
            return Promise.all(
                emails.map((email = {}) => {
                    return extendInvalid(extendPGP(email, sendPreferencesMap[email.Address]));
                })
            );
        };

        /**
         * Update the cached information with new emails and emails to remove.
         * @param {Array} emailsToAdd
         * @param {Array} emailsToRemove
         */
        const updateCache = (emailsToAdd = [], emailsToRemove = []) => {
            emailsToAdd.forEach((email = {}) => {
                const { Address } = email;
                CACHE[Address] = email;
            });
            emailsToRemove.forEach((address) => {
                delete CACHE[address];
            });
        };

        /**
         * Sync a list of emails to the cache.
         * Handle the invalid ones by prompting the user, and update the new ones in the cache.
         * @param {Array} emails
         * @returns {Promise}
         */
        const sync = async (emails = []) => {
            const addresses = _.map(emails, 'Address');

            // Get the sending preferences for all email addresses. Instruct it to catch any errors silently.
            const sendPreferencesMap = await sendPreferences.get(addresses, message, true);

            // Get a list of email addresses that failed to fetch from sendPreferences by taking the difference of the argument and the result.
            const failedAddresses = _.difference(addresses, Object.keys(sendPreferencesMap));

            // Prompt the user to handle any invalid addresses.
            const invalidAddresses = await handleInvalid(sendPreferencesMap);

            // The addresses that need to be removed are those with invalid settings and the ones that failed to fetch.
            const addressesToRemove = invalidAddresses.concat(failedAddresses);

            // Filter the emails that need to be updated in the cache.
            const filteredEmails = emails.filter(({ Address }) => !addressesToRemove.includes(Address));

            // Extend the emails.
            const extendedEmails = await extendAsync(filteredEmails, sendPreferencesMap);

            // Update the cache with the extended emails and those to remove.
            updateCache(extendedEmails, addressesToRemove);

            return {
                addressesToRemove,
                failedAddresses
            };
        };

        return { extendFromCache, sync };
    };
}

export default autocompleteSyncModel;
