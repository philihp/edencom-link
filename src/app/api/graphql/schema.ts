import { createSchema } from 'graphql-yoga'

import { resolvers } from './resolvers'
import { typeDefs } from './schema.graphql'

export const schema = createSchema({ typeDefs, resolvers })
