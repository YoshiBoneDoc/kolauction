export function createPollService(client) {
    async function call(name, args) {
        if (!client) throw new Error('Polls are temporarily unavailable.');
        const { data, error } = await client.rpc(name, args);
        if (error) throw new Error(error.message || 'The poll could not be updated. Please try again.');
        return data;
    }
    return {
        read: () => call('read_home_poll_feed'),
        list: () => call('read_admin_polls'),
        voters: id => call('read_poll_voters', { p_poll_id: id }),
        saveDraft: (question, id = null, type = 'yes_no', multiple = false, choices = []) => call('save_poll_draft', { p_question: question, p_poll_id: id, p_poll_type: type, p_allow_multiple: multiple, p_choices: choices }),
        skip: id => call('skip_home_poll', { p_poll_id: id }),
        respond: (id, response, requestId) => call('respond_to_home_poll', { p_poll_id: id, p_response: response, p_request_id: requestId }),
        publish: (id, concludeCurrent = false) => call('publish_poll', { p_poll_id: id, p_conclude_current: concludeCurrent }),
        publishResults: (id, publish) => call('publish_poll_results', { p_poll_id: id, p_publish: publish }),
        vote: (id, answer) => call('vote_home_poll', { p_poll_id: id, p_answer: answer }),
        voteChoice: (id, choice) => call('vote_home_poll_choice', { p_poll_id: id, p_choice: choice }),
        close: id => call('close_home_poll', { p_poll_id: id }),
        remove: id => call('delete_home_poll', { p_poll_id: id }),
    };
}
