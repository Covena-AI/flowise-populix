import { BaseLanguageModel } from '@langchain/core/language_models/base'
import { CallbackManagerForChainRun } from '@langchain/core/callbacks/manager'
import { BaseChain, ChainInputs, LLMChain, SerializedAPIChain } from 'langchain/chains'
import { BasePromptTemplate, PromptTemplate } from '@langchain/core/prompts'
import { ChainValues } from '@langchain/core/utils/types'
import fetch from 'node-fetch'
import { BaseLLMOutputParser } from '@langchain/core/output_parsers'

export const API_URL_RAW_PROMPT_TEMPLATE = `You are given the below API Documentation:
{api_docs}
Using this documentation, generate a json string with key: "url"
The value of "url" should be a string, which is the API url, including its params to call for answering the user question.
Be careful to always use double quotes for strings in the json string.
You should build the json string in order to get a response that is as short as possible, while still getting the necessary information to answer the question. Pay attention to deliberately exclude any unnecessary pieces of data in the API call.

Question:{question}
json string:`

export const API_RESPONSE_RAW_PROMPT_TEMPLATE = `given this {api_response} response for {api_url_body}

Summarize this response to answer the original question.

Summary:`

const defaultApiUrlPrompt = new PromptTemplate({
    inputVariables: ['api_docs', 'question'],
    template: API_URL_RAW_PROMPT_TEMPLATE
})

const defaultApiResponsePrompt = new PromptTemplate({
    inputVariables: ['api_docs', 'question', 'api_url_body', 'api_response'],
    template: API_RESPONSE_RAW_PROMPT_TEMPLATE
})

export interface APIChainInput extends Omit<ChainInputs, 'memory'> {
    apiAnswerChain: LLMChain<string | object>
    apiRequestChain: LLMChain
    apiDocs: string
    inputKey?: string
    headers?: Record<string, string>
    /** Key to use for output, defaults to `output` */
    outputKey?: string
}

export type APIChainOptions = {
    headers?: Record<string, string>
    apiUrlPrompt?: BasePromptTemplate
    apiResponsePrompt?: BasePromptTemplate
    outputParser?: BaseLLMOutputParser
}

export class APIChain extends BaseChain implements APIChainInput {
    apiAnswerChain: LLMChain<string | object>

    apiRequestChain: LLMChain

    apiDocs: string

    headers = {}

    inputKey = 'question'

    outputKey = 'output'

    get inputKeys() {
        return [this.inputKey]
    }

    get outputKeys() {
        return [this.outputKey]
    }

    constructor(fields: APIChainInput) {
        super(fields)
        this.apiRequestChain = fields.apiRequestChain
        this.apiAnswerChain = fields.apiAnswerChain
        this.apiDocs = fields.apiDocs
        this.inputKey = fields.inputKey ?? this.inputKey
        this.outputKey = fields.outputKey ?? this.outputKey
        this.headers = fields.headers ?? this.headers
    }

    /** @ignore */
    async _call(values: ChainValues, runManager?: CallbackManagerForChainRun): Promise<ChainValues> {
        try {
            const question: string = values[this.inputKey]

            const api_url_body = await this.apiRequestChain.predict({ question, api_docs: this.apiDocs }, runManager?.getChild())

            const { url, data } = JSON.parse(api_url_body)

            const res = await fetch(url, {
                method: 'GET',
                headers: this.headers
                // body: JSON.stringify(data)
            })

            const api_response = await res.text()

            const answer = await this.apiAnswerChain.predict(
                { question, api_docs: this.apiDocs, api_url_body, api_response },
                runManager?.getChild()
            )

            return { [this.outputKey]: answer }
        } catch (error) {
            return { [this.outputKey]: error }
        }
    }

    _chainType() {
        return 'api_chain' as const
    }

    static async deserialize(data: SerializedAPIChain) {
        const { api_request_chain, api_answer_chain, api_docs } = data

        if (!api_request_chain) {
            throw new Error('LLMChain must have api_request_chain')
        }
        if (!api_answer_chain) {
            throw new Error('LLMChain must have api_answer_chain')
        }
        if (!api_docs) {
            throw new Error('LLMChain must have api_docs')
        }

        return new APIChain({
            apiAnswerChain: await LLMChain.deserialize(api_answer_chain),
            apiRequestChain: await LLMChain.deserialize(api_request_chain),
            apiDocs: api_docs
        })
    }

    serialize(): SerializedAPIChain {
        return {
            _type: this._chainType(),
            api_answer_chain: this.apiAnswerChain.serialize(),
            api_request_chain: this.apiRequestChain.serialize(),
            api_docs: this.apiDocs
        }
    }

    static fromLLMAndAPIDocs(
        llm: BaseLanguageModel,
        apiDocs: string,
        options: APIChainOptions & Omit<APIChainInput, 'apiAnswerChain' | 'apiRequestChain' | 'apiDocs'> = {}
    ): APIChain {
        const { apiUrlPrompt = defaultApiUrlPrompt, apiResponsePrompt = defaultApiResponsePrompt, outputParser = undefined } = options
        const apiRequestChain = new LLMChain({ prompt: apiUrlPrompt, llm })
        // let promptValues = apiResponsePrompt
        // if (outputParser) {
        //     promptValues = injectOutputParser(outputParser, apiRequestChain, apiResponsePrompt)
        // }
        const apiAnswerChain = new LLMChain({
            prompt: apiResponsePrompt,
            llm,
            outputParser: outputParser as BaseLLMOutputParser<string | object>
        })
        return new this({
            apiAnswerChain,
            apiRequestChain,
            apiDocs,
            ...options
        })
    }
}